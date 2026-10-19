// @ts-check
// Building blocks shared by both ends of a FIX session: the standard header and a
// small client that numbers its own messages.

import { MSG_TYPES } from "./dictionary.js";
import { encode, formatPrice, utcTimestamp } from "./fix.js";

/** @typedef {import("./fix.js").Field} Field */
/** @typedef {import("./orderBook.js").Side} Side */

export const SIDE_TO_FIX = /** @type {const} */ ({ buy: "1", sell: "2" });
export const FIX_TO_SIDE = /** @type {Record<string, Side>} */ ({ 1: "buy", 2: "sell" });
export const ORD_TYPE_TO_FIX = /** @type {const} */ ({ market: "1", limit: "2" });

/**
 * Encodes a message with the standard header: MsgType, SenderCompID, TargetCompID,
 * MsgSeqNum, SendingTime.
 *
 * @param {string} type
 * @param {{ sender: string, target: string, seq: number, time: number }} header
 * @param {Field[]} [fields]
 */
export function buildMessage(type, { sender, target, seq, time }, fields = []) {
  return encode([
    [35, type],
    [49, sender],
    [56, target],
    [34, String(seq)],
    [52, utcTimestamp(time)],
    ...fields,
  ]);
}

/**
 * @typedef {object} OrderRequest
 * @property {string} clOrdId
 * @property {string} symbol
 * @property {Side} side
 * @property {"limit" | "market"} type
 * @property {number | null} [price] Integer cents, for limit orders.
 * @property {number} qty
 * @property {"day" | "ioc"} [tif] TimeInForce. Market orders are always IOC.
 */

/** The client end of a session: it builds every message it sends, in sequence. */
export class FixClient {
  /**
   * @param {{ senderCompId: string, targetCompId: string, clock?: () => number }} options
   */
  constructor({ senderCompId, targetCompId, clock = Date.now }) {
    this.senderCompId = senderCompId;
    this.targetCompId = targetCompId;
    this.clock = clock;
    this.seq = 1;
  }

  /**
   * @param {string} type
   * @param {Field[]} [fields]
   */
  send(type, fields = []) {
    return buildMessage(
      type,
      { sender: this.senderCompId, target: this.targetCompId, seq: this.seq++, time: this.clock() },
      fields
    );
  }

  /** Starts a fresh session: sequence numbers restart at 1. */
  logon(heartBtInt = 30) {
    this.seq = 1;
    return this.send(MSG_TYPES.LOGON, [
      [98, "0"],
      [108, String(heartBtInt)],
    ]);
  }

  /** @param {string} [text] */
  logout(text) {
    return this.send(MSG_TYPES.LOGOUT, text ? [[58, text]] : []);
  }

  /** @param {string} [testReqId] Echoed back when answering a TestRequest. */
  heartbeat(testReqId) {
    return this.send(MSG_TYPES.HEARTBEAT, testReqId ? [[112, testReqId]] : []);
  }

  /** @param {OrderRequest} order */
  newOrder({ clOrdId, symbol, side, type, price, qty, tif = "day" }) {
    /** @type {Field[]} */
    const fields = [
      [11, clOrdId],
      [55, symbol],
      [54, SIDE_TO_FIX[side]],
      [60, utcTimestamp(this.clock())],
      [38, String(qty)],
      [40, ORD_TYPE_TO_FIX[type]],
    ];
    if (type === "limit" && typeof price === "number") fields.push([44, formatPrice(price)]);
    fields.push([59, type === "market" || tif === "ioc" ? "3" : "0"]);
    return this.send(MSG_TYPES.NEW_ORDER_SINGLE, fields);
  }

  /**
   * @param {{ clOrdId: string, origClOrdId: string, symbol: string, side: Side }} request
   */
  cancel({ clOrdId, origClOrdId, symbol, side }) {
    return this.send(MSG_TYPES.ORDER_CANCEL_REQUEST, [
      [41, origClOrdId],
      [11, clOrdId],
      [55, symbol],
      [54, SIDE_TO_FIX[side]],
      [60, utcTimestamp(this.clock())],
    ]);
  }
}
