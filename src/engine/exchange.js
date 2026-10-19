// @ts-check
// The exchange end of every session. It accepts raw FIX, enforces session rules
// (logon, sequence numbers, heartbeats), runs pre-trade risk checks, matches orders,
// and answers with ExecutionReports, exactly as a venue's FIX gateway would.

import { MSG_TYPES } from "./dictionary.js";
import { decode, formatPrice, parsePrice, utcTimestamp } from "./fix.js";
import { OrderBook } from "./orderBook.js";
import { FIX_TO_SIDE, SIDE_TO_FIX, buildMessage } from "./session.js";

/** @typedef {import("./fix.js").Field} Field */
/** @typedef {import("./fix.js").ParsedMessage} ParsedMessage */
/** @typedef {import("./orderBook.js").Side} Side */

/** @typedef {{ to: string, raw: string }} Outbound */

/**
 * @typedef {object} Trade
 * @property {string} symbol
 * @property {number} price  Integer cents.
 * @property {number} qty
 * @property {Side} aggressor  Side of the incoming order that caused the trade.
 * @property {string} buyer
 * @property {string} seller
 * @property {number} time
 */

/**
 * @typedef {object} OrderState
 * @property {string} orderId
 * @property {string} clOrdId    Latest ClOrdID (changes on cancel).
 * @property {string} owner
 * @property {string} symbol
 * @property {Side} side
 * @property {"limit" | "market"} type
 * @property {number | null} price
 * @property {number} qty
 * @property {number} cumQty
 * @property {number} notional   Sum of price × qty over fills, in cents.
 * @property {"0" | "1" | "2" | "4" | "8"} status  OrdStatus (39).
 */

/**
 * @typedef {object} Session
 * @property {boolean} loggedOn
 * @property {number} expectedSeq  Next MsgSeqNum we expect from the client.
 * @property {number} outSeq       Next MsgSeqNum we send.
 * @property {number} heartBtInt   Seconds.
 * @property {number} lastSentAt
 */

/** Largest order a single message may carry (a "fat finger" guard). */
export const MAX_ORDER_QTY = 100_000;
/** Limit prices further than this from the last trade are rejected. */
export const PRICE_BAND = 0.2;

const TERMINAL = new Set(["2", "4", "8"]);

export class Exchange {
  /**
   * @param {{ symbols: Record<string, { refPrice: number }>, compId?: string, clock?: () => number }} options
   */
  constructor({ symbols, compId = "FIXFLOW", clock = Date.now }) {
    this.compId = compId;
    this.clock = clock;
    /** @type {Map<string, OrderBook>} */
    this.books = new Map(Object.keys(symbols).map((symbol) => [symbol, new OrderBook(symbol)]));
    /** @type {Map<string, number>} */
    this.lastPrice = new Map(Object.entries(symbols).map(([symbol, { refPrice }]) => [symbol, refPrice]));
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    /** @type {Map<string, OrderState>} */
    this.orders = new Map();
    /** @type {Map<string, string>} owner + ClOrdID → OrderID */
    this.clOrdIndex = new Map();
    this.nextOrderId = 1;
    this.nextExecId = 1;
  }

  /**
   * Handles one inbound message.
   *
   * @param {string} raw
   * @returns {{ outbound: Outbound[], trades: Trade[] }}
   */
  receive(raw) {
    /** @type {Outbound[]} */
    const outbound = [];
    /** @type {Trade[]} */
    const trades = [];
    const ctx = { outbound, trades };

    const result = decode(raw);
    const message = result.message;
    const sender = message.get(49);
    if (!sender) return ctx; // Nobody to answer: a real gateway would just drop it.

    const session = this.#session(sender);
    const seq = Number(message.get(34));

    if (!result.ok) {
      this.#reject(ctx, sender, seq, result.error, "5");
      return ctx;
    }
    if (message.get(56) !== this.compId) {
      this.#reject(ctx, sender, seq, `TargetCompID must be ${this.compId}`, "9", 56);
      return ctx;
    }
    if (!Number.isInteger(seq) || seq <= 0) {
      this.#reject(ctx, sender, seq, "MsgSeqNum (34) is required", "1", 34);
      return ctx;
    }

    if (message.type === MSG_TYPES.LOGON) {
      this.#logon(ctx, sender, session, message, seq);
      return ctx;
    }
    if (!session.loggedOn) {
      this.#send(ctx, sender, MSG_TYPES.LOGOUT, [[58, "First message must be Logon"]]);
      return ctx;
    }
    if (seq !== session.expectedSeq) {
      const problem = seq < session.expectedSeq ? "too low" : "too high";
      this.#reject(
        ctx,
        sender,
        seq,
        `MsgSeqNum ${problem}: expected ${session.expectedSeq}, got ${seq}`,
        "5",
        34
      );
      session.expectedSeq = seq + 1;
      return ctx;
    }
    session.expectedSeq++;

    switch (message.type) {
      case MSG_TYPES.HEARTBEAT:
        break;
      case MSG_TYPES.TEST_REQUEST:
        this.#send(ctx, sender, MSG_TYPES.HEARTBEAT, [[112, message.get(112) ?? ""]]);
        break;
      case MSG_TYPES.LOGOUT:
        this.#send(ctx, sender, MSG_TYPES.LOGOUT);
        session.loggedOn = false;
        break;
      case MSG_TYPES.NEW_ORDER_SINGLE:
        this.#newOrder(ctx, sender, message, seq);
        break;
      case MSG_TYPES.ORDER_CANCEL_REQUEST:
        this.#cancel(ctx, sender, message, seq);
        break;
      default:
        this.#reject(ctx, sender, seq, `Unsupported MsgType ${message.type}`, "11", 35);
    }
    return ctx;
  }

  /**
   * Sends a Heartbeat on every logged-on session that has been quiet for HeartBtInt.
   *
   * @returns {Outbound[]}
   */
  tick() {
    /** @type {Outbound[]} */
    const outbound = [];
    const now = this.clock();
    for (const [compId, session] of this.sessions) {
      if (session.loggedOn && now - session.lastSentAt >= session.heartBtInt * 1000) {
        this.#send({ outbound }, compId, MSG_TYPES.HEARTBEAT);
      }
    }
    return outbound;
  }

  /**
   * Book depth plus last price, for market data displays.
   *
   * @param {string} symbol
   * @param {number} levels
   */
  snapshot(symbol, levels) {
    const book = this.books.get(symbol);
    if (!book) throw new Error(`Unknown symbol ${symbol}`);
    return { symbol, last: this.lastPrice.get(symbol) ?? null, ...book.depth(levels) };
  }

  // ---------- Session layer ----------

  /** @param {string} compId */
  #session(compId) {
    let session = this.sessions.get(compId);
    if (!session) {
      session = { loggedOn: false, expectedSeq: 1, outSeq: 1, heartBtInt: 30, lastSentAt: 0 };
      this.sessions.set(compId, session);
    }
    return session;
  }

  /**
   * @param {{ outbound: Outbound[] }} ctx
   * @param {string} to
   * @param {string} type
   * @param {Field[]} [fields]
   */
  #send(ctx, to, type, fields = []) {
    const session = this.#session(to);
    const time = this.clock();
    ctx.outbound.push({
      to,
      raw: buildMessage(type, { sender: this.compId, target: to, seq: session.outSeq++, time }, fields),
    });
    session.lastSentAt = time;
  }

  /**
   * Session-level Reject (35=3): the message itself was unacceptable.
   *
   * @param {{ outbound: Outbound[] }} ctx
   * @param {string} to
   * @param {number} refSeq
   * @param {string} text
   * @param {string} reason SessionRejectReason (373).
   * @param {number} [refTag]
   */
  #reject(ctx, to, refSeq, text, reason, refTag) {
    /** @type {Field[]} */
    const fields = [];
    if (Number.isInteger(refSeq) && refSeq > 0) fields.push([45, String(refSeq)]);
    if (refTag !== undefined) fields.push([371, String(refTag)]);
    fields.push([373, reason], [58, text]);
    this.#send(ctx, to, MSG_TYPES.REJECT, fields);
  }

  /**
   * @param {{ outbound: Outbound[] }} ctx
   * @param {string} sender
   * @param {Session} session
   * @param {ParsedMessage} message
   * @param {number} seq
   */
  #logon(ctx, sender, session, message, seq) {
    const heartBtInt = Number(message.get(108));
    if (!Number.isInteger(heartBtInt) || heartBtInt <= 0) {
      this.#send(ctx, sender, MSG_TYPES.LOGOUT, [[58, "HeartBtInt (108) must be a positive integer"]]);
      return;
    }
    if (seq === 1) session.outSeq = 1; // A fresh session restarts numbering on both sides.
    Object.assign(session, { loggedOn: true, expectedSeq: seq + 1, heartBtInt });
    this.#send(ctx, sender, MSG_TYPES.LOGON, [
      [98, "0"],
      [108, String(heartBtInt)],
    ]);
  }

  // ---------- Application layer ----------

  /**
   * @param {{ outbound: Outbound[], trades: Trade[] }} ctx
   * @param {string} owner
   * @param {ParsedMessage} message
   * @param {number} seq
   */
  #newOrder(ctx, owner, message, seq) {
    for (const tag of [11, 55, 54, 38, 40]) {
      if (!message.get(tag)) return this.#reject(ctx, owner, seq, `Required tag ${tag} missing`, "1", tag);
    }
    const side = FIX_TO_SIDE[/** @type {string} */ (message.get(54))];
    if (!side) return this.#reject(ctx, owner, seq, "Side (54) must be 1 or 2", "5", 54);
    const ordType = message.get(40);
    if (ordType !== "1" && ordType !== "2") {
      return this.#reject(ctx, owner, seq, "OrdType (40) must be 1 (Market) or 2 (Limit)", "5", 40);
    }

    const clOrdId = /** @type {string} */ (message.get(11));
    const symbol = /** @type {string} */ (message.get(55));
    const type = ordType === "1" ? "market" : "limit";
    const qtyText = /** @type {string} */ (message.get(38));
    const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
    const price = type === "limit" ? parsePrice(message.get(44)) : null;

    /** @type {OrderState} */
    const order = {
      orderId: `O${this.nextOrderId++}`,
      clOrdId,
      owner,
      symbol,
      side,
      type,
      price,
      qty: Number.isFinite(qty) ? qty : 0,
      cumQty: 0,
      notional: 0,
      status: "0",
    };

    const problem = this.#riskCheck(order, qty, message.get(44));
    if (problem) {
      order.status = "8";
      this.#execReport(ctx, order, "8", { text: problem });
      return;
    }

    this.orders.set(order.orderId, order);
    this.clOrdIndex.set(`${owner}\u0000${clOrdId}`, order.orderId);
    this.#execReport(ctx, order, "0");

    const book = /** @type {OrderBook} */ (this.books.get(symbol));
    const ioc = type === "market" || message.get(59) === "3";
    const result = book.submit({ id: order.orderId, side, type, price, qty, owner, ioc });

    for (const fill of result.fills) {
      const maker = /** @type {OrderState} */ (this.orders.get(fill.makerId));
      for (const party of [order, maker]) {
        party.cumQty += fill.qty;
        party.notional += fill.qty * fill.price;
        party.status = party.cumQty === party.qty ? "2" : "1";
      }
      this.lastPrice.set(symbol, fill.price);
      ctx.trades.push({
        symbol,
        price: fill.price,
        qty: fill.qty,
        aggressor: side,
        buyer: side === "buy" ? owner : maker.owner,
        seller: side === "sell" ? owner : maker.owner,
        time: this.clock(),
      });
      this.#execReport(ctx, order, "F", { lastQty: fill.qty, lastPx: fill.price });
      this.#execReport(ctx, maker, "F", { lastQty: fill.qty, lastPx: fill.price });
    }

    if (ioc && result.remaining > 0) {
      order.status = "4";
      this.#execReport(ctx, order, "4", { text: "No liquidity for the remaining quantity" });
    }
  }

  /**
   * Pre-trade checks. Returns a reason to reject, or null to accept.
   *
   * @param {OrderState} order
   * @param {number} qty
   * @param {string | undefined} priceText
   */
  #riskCheck(order, qty, priceText) {
    if (!this.books.has(order.symbol)) return `Unknown symbol ${order.symbol}`;
    if (!Number.isInteger(qty) || qty <= 0) return "OrderQty must be a positive whole number";
    if (qty > MAX_ORDER_QTY)
      return `OrderQty exceeds the ${MAX_ORDER_QTY.toLocaleString("en-US")} share limit`;
    if (this.clOrdIndex.has(`${order.owner}\u0000${order.clOrdId}`))
      return `Duplicate ClOrdID ${order.clOrdId}`;

    if (order.type === "limit") {
      if (order.price === null || order.price <= 0) {
        return `Price (44) "${priceText ?? ""}" must be a positive number with up to 2 decimals`;
      }
      const reference = /** @type {number} */ (this.lastPrice.get(order.symbol));
      if (Math.abs(order.price - reference) > reference * PRICE_BAND) {
        return `Price is more than ${PRICE_BAND * 100}% away from the last trade (${formatPrice(reference)})`;
      }
    }
    return null;
  }

  /**
   * @param {{ outbound: Outbound[], trades: Trade[] }} ctx
   * @param {string} owner
   * @param {ParsedMessage} message
   * @param {number} seq
   */
  #cancel(ctx, owner, message, seq) {
    for (const tag of [41, 11, 55, 54]) {
      if (!message.get(tag)) return this.#reject(ctx, owner, seq, `Required tag ${tag} missing`, "1", tag);
    }
    const origClOrdId = /** @type {string} */ (message.get(41));
    const clOrdId = /** @type {string} */ (message.get(11));
    const orderId = this.clOrdIndex.get(`${owner}\u0000${origClOrdId}`);
    const order = orderId ? this.orders.get(orderId) : undefined;

    if (!order || order.symbol !== message.get(55)) {
      return this.#cancelReject(
        ctx,
        owner,
        { clOrdId, origClOrdId, orderId: "NONE", status: "8" },
        "1",
        "Unknown order"
      );
    }
    if (TERMINAL.has(order.status)) {
      const text = order.status === "2" ? "Order is already filled" : "Order is already closed";
      return this.#cancelReject(
        ctx,
        owner,
        { clOrdId, origClOrdId, orderId: order.orderId, status: order.status },
        "0",
        text
      );
    }

    /** @type {OrderBook} */ (this.books.get(order.symbol)).cancel(order.orderId);
    order.status = "4";
    order.clOrdId = clOrdId;
    this.clOrdIndex.set(`${owner}\u0000${clOrdId}`, order.orderId);
    this.#execReport(ctx, order, "4", { origClOrdId });
  }

  /**
   * @param {{ outbound: Outbound[] }} ctx
   * @param {string} to
   * @param {{ clOrdId: string, origClOrdId: string, orderId: string, status: string }} ids
   * @param {"0" | "1"} reason CxlRejReason (102).
   * @param {string} text
   */
  #cancelReject(ctx, to, { clOrdId, origClOrdId, orderId, status }, reason, text) {
    this.#send(ctx, to, MSG_TYPES.ORDER_CANCEL_REJECT, [
      [37, orderId],
      [11, clOrdId],
      [41, origClOrdId],
      [39, status],
      [434, "1"],
      [102, reason],
      [58, text],
    ]);
  }

  /**
   * @param {{ outbound: Outbound[] }} ctx
   * @param {OrderState} order
   * @param {"0" | "4" | "8" | "F"} execType
   * @param {{ lastQty?: number, lastPx?: number, text?: string, origClOrdId?: string }} [extra]
   */
  #execReport(ctx, order, execType, { lastQty, lastPx, text, origClOrdId } = {}) {
    const leaves = TERMINAL.has(order.status) ? 0 : order.qty - order.cumQty;

    /** @type {Field[]} */
    const fields = [
      [37, order.orderId],
      [11, order.clOrdId],
    ];
    if (origClOrdId) fields.push([41, origClOrdId]);
    fields.push(
      [17, `E${this.nextExecId++}`],
      [150, execType],
      [39, order.status],
      [55, order.symbol],
      [54, SIDE_TO_FIX[order.side]],
      [38, String(order.qty)],
      [40, order.type === "market" ? "1" : "2"]
    );
    if (order.price !== null) fields.push([44, formatPrice(order.price)]);
    if (lastQty !== undefined && lastPx !== undefined)
      fields.push([32, String(lastQty)], [31, formatPrice(lastPx)]);
    fields.push(
      [151, String(leaves)],
      [14, String(order.cumQty)],
      [6, averagePrice(order)],
      [60, utcTimestamp(this.clock())]
    );
    if (text) fields.push([58, text]);

    this.#send(ctx, order.owner, MSG_TYPES.EXECUTION_REPORT, fields);
  }
}

/**
 * Volume-weighted average fill price as a FIX decimal.
 *
 * @param {{ cumQty: number, notional: number }} order
 */
export function averagePrice({ cumQty, notional }) {
  if (cumQty === 0) return "0";
  const cents = notional / cumQty;
  return Number.isInteger(cents) ? formatPrice(cents) : (cents / 100).toFixed(4);
}
