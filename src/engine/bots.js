// @ts-check
// Simulated market participants. Each bot is a real FIX client: it logs on, sends
// NewOrderSingle and OrderCancelRequest messages, and goes through the same gateway,
// risk checks and matching as the person using the app.

import { FixClient } from "./session.js";

/** @typedef {import("./random.js").Random} Random */

/** @typedef {Record<string, { refPrice: number }>} SymbolConfig */

/**
 * Quotes a ladder of bids and asks around a fair value that drifts randomly,
 * replacing its quotes every few ticks so the book keeps moving.
 */
export class MarketMaker {
  /**
   * @param {{ compId: string, symbols: SymbolConfig, random: Random, clock?: () => number, levels?: number }} options
   */
  constructor({ compId, symbols, random, clock = Date.now, levels = 10 }) {
    this.client = new FixClient({ senderCompId: compId, targetCompId: "FIXFLOW", clock });
    this.random = random;
    this.levels = levels;
    /** @type {Map<string, number>} Fair value per symbol, in cents. */
    this.fair = new Map(Object.entries(symbols).map(([s, { refPrice }]) => [s, refPrice]));
    /** @type {Map<string, number>} */
    this.ref = new Map(this.fair);
    /** @type {{ clOrdId: string, symbol: string, side: "buy" | "sell" }[]} */
    this.live = [];
    this.nextId = 1;
  }

  logon() {
    return this.client.logon(30);
  }

  /**
   * Messages to send this tick: cancel the previous quotes for one symbol, then
   * re-quote it around a fair value that has taken one random step.
   *
   * @param {string} symbol
   * @returns {string[]}
   */
  requote(symbol) {
    const messages = [];
    const stale = this.live.filter((q) => q.symbol === symbol);
    this.live = this.live.filter((q) => q.symbol !== symbol);
    for (const quote of stale) {
      messages.push(this.client.cancel({ ...quote, origClOrdId: quote.clOrdId, clOrdId: this.#id() }));
    }

    const fair = this.#step(symbol);
    const halfSpread = this.random.int(1, 3);
    for (let level = 0; level < this.levels; level++) {
      const offset = halfSpread + level * this.random.int(1, 3);
      for (const side of /** @type {const} */ (["buy", "sell"])) {
        const clOrdId = this.#id();
        const price = side === "buy" ? fair - offset : fair + offset;
        const qty = this.random.int(1, 8) * 100;
        messages.push(this.client.newOrder({ clOrdId, symbol, side, type: "limit", price, qty }));
        this.live.push({ clOrdId, symbol, side });
      }
    }
    return messages;
  }

  /** One step of a mean-reverting random walk, in whole cents. */
  #step(/** @type {string} */ symbol) {
    const fair = /** @type {number} */ (this.fair.get(symbol));
    const ref = /** @type {number} */ (this.ref.get(symbol));
    const pull = (ref - fair) * 0.02;
    const next = Math.max(100, Math.round(fair + pull + this.random.gaussian() * ref * 0.0006));
    this.fair.set(symbol, next);
    return next;
  }

  #id() {
    return `MM-${this.nextId++}`;
  }
}

/** Sends occasional marketable orders, which is what makes trades print. */
export class NoiseTrader {
  /**
   * @param {{ compId: string, random: Random, clock?: () => number }} options
   */
  constructor({ compId, random, clock = Date.now }) {
    this.client = new FixClient({ senderCompId: compId, targetCompId: "FIXFLOW", clock });
    this.random = random;
    this.nextId = 1;
  }

  logon() {
    return this.client.logon(30);
  }

  /**
   * @param {string} symbol
   * @param {{ bid: number | null, ask: number | null }} top Current best prices.
   * @returns {string[]}
   */
  trade(symbol, top) {
    const side = this.random.chance(0.5) ? "buy" : "sell";
    const qty = this.random.int(1, 5) * 100;
    const clOrdId = `NT-${this.client.senderCompId}-${this.nextId++}`;
    const touch = side === "buy" ? top.ask : top.bid;

    if (touch === null || this.random.chance(0.4)) {
      return [this.client.newOrder({ clOrdId, symbol, side, type: "market", qty })];
    }
    // A marketable limit that reaches one or two cents through the touch.
    const reach = this.random.int(0, 2);
    const price = side === "buy" ? touch + reach : touch - reach;
    return [this.client.newOrder({ clOrdId, symbol, side, type: "limit", price, qty, tif: "ioc" })];
  }
}
