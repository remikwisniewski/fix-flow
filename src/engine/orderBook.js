// @ts-check
// A limit order book with price-time priority: the best price trades first, and at the
// same price the order that arrived first trades first. Prices are integer cents.

/** @typedef {"buy" | "sell"} Side */

/**
 * @typedef {object} RestingOrder
 * @property {string} id
 * @property {Side} side
 * @property {number} price      Integer cents.
 * @property {number} remaining  Quantity still open.
 * @property {string} owner      Session that owns the order.
 */

/**
 * @typedef {object} Fill
 * @property {string} makerId  The resting order.
 * @property {string} makerOwner
 * @property {number} price    Trades happen at the maker's price.
 * @property {number} qty
 * @property {number} makerRemaining  What the maker has left after this fill.
 */

/**
 * @typedef {object} Level
 * @property {number} price
 * @property {RestingOrder[]} queue  FIFO: index 0 has time priority.
 */

/**
 * @typedef {object} IncomingOrder
 * @property {string} id
 * @property {Side} side
 * @property {"limit" | "market"} type
 * @property {number | null} price  Required for limit orders.
 * @property {number} qty
 * @property {string} owner
 * @property {boolean} [ioc]  Immediate or cancel: never rest the remainder.
 */

export class OrderBook {
  /** @param {string} symbol */
  constructor(symbol) {
    this.symbol = symbol;
    /** @type {Level[]} Best (highest) first. */
    this.bids = [];
    /** @type {Level[]} Best (lowest) first. */
    this.asks = [];
    /** @type {Map<string, RestingOrder>} */
    this.index = new Map();
  }

  /**
   * Matches an order against the opposite side, then rests any limit remainder.
   * Market and IOC orders return their unfilled remainder instead of resting it.
   *
   * @param {IncomingOrder} order
   * @returns {{ fills: Fill[], remaining: number, rested: boolean }}
   */
  submit(order) {
    if (!Number.isInteger(order.qty) || order.qty <= 0) throw new Error("qty must be a positive integer");
    if (order.type === "limit" && !Number.isInteger(order.price))
      throw new Error("limit orders need a price");
    if (this.index.has(order.id)) throw new Error(`duplicate order id ${order.id}`);

    const opposite = order.side === "buy" ? this.asks : this.bids;
    /** @type {Fill[]} */
    const fills = [];
    let remaining = order.qty;

    while (remaining > 0 && opposite.length > 0) {
      const level = opposite[0];
      if (order.type === "limit" && !crosses(order.side, /** @type {number} */ (order.price), level.price))
        break;

      const maker = level.queue[0];
      const qty = Math.min(remaining, maker.remaining);
      maker.remaining -= qty;
      remaining -= qty;
      fills.push({
        makerId: maker.id,
        makerOwner: maker.owner,
        price: level.price,
        qty,
        makerRemaining: maker.remaining,
      });

      if (maker.remaining === 0) {
        level.queue.shift();
        this.index.delete(maker.id);
        if (level.queue.length === 0) opposite.shift();
      }
    }

    const rested = order.type === "limit" && !order.ioc && remaining > 0;
    if (rested) {
      this.#rest({
        id: order.id,
        side: order.side,
        price: /** @type {number} */ (order.price),
        remaining,
        owner: order.owner,
      });
    }

    return { fills, remaining, rested };
  }

  /**
   * Removes a resting order.
   *
   * @param {string} id
   * @returns {RestingOrder | null} The order as it was, or null if it isn't resting.
   */
  cancel(id) {
    const order = this.index.get(id);
    if (!order) return null;

    const levels = order.side === "buy" ? this.bids : this.asks;
    const at = levels.findIndex((level) => level.price === order.price);
    const level = levels[at];
    level.queue.splice(level.queue.indexOf(order), 1);
    if (level.queue.length === 0) levels.splice(at, 1);
    this.index.delete(id);
    return order;
  }

  /** @param {string} id */
  get(id) {
    return this.index.get(id) ?? null;
  }

  /** Best bid and ask prices, or null for an empty side. */
  top() {
    return { bid: this.bids[0]?.price ?? null, ask: this.asks[0]?.price ?? null };
  }

  /**
   * Aggregated depth: total quantity and order count per price.
   *
   * @param {number} levels
   */
  depth(levels) {
    const summarize = (/** @type {Level} */ level) => ({
      price: level.price,
      qty: level.queue.reduce((sum, order) => sum + order.remaining, 0),
      orders: level.queue.length,
    });
    return {
      bids: this.bids.slice(0, levels).map(summarize),
      asks: this.asks.slice(0, levels).map(summarize),
    };
  }

  /** @param {RestingOrder} order */
  #rest(order) {
    const levels = order.side === "buy" ? this.bids : this.asks;
    /** @type {(a: number, b: number) => boolean} */
    const better = order.side === "buy" ? (a, b) => a > b : (a, b) => a < b;

    // Binary search for the first level the new price is better than (or equal to).
    let lo = 0;
    let hi = levels.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (better(levels[mid].price, order.price)) lo = mid + 1;
      else hi = mid;
    }

    if (levels[lo]?.price === order.price) levels[lo].queue.push(order);
    else levels.splice(lo, 0, { price: order.price, queue: [order] });
    this.index.set(order.id, order);
  }
}

/**
 * Whether an incoming limit price can trade against a resting level.
 *
 * @param {Side} side Side of the incoming order.
 * @param {number} limit
 * @param {number} levelPrice
 */
export function crosses(side, limit, levelPrice) {
  return side === "buy" ? limit >= levelPrice : limit <= levelPrice;
}
