// @ts-check
// Wires the exchange and the bots into one market that advances a tick at a time.
// It has no timers and no DOM, so the Web Worker drives it in the browser and the
// tests drive it step by step.

import { decode } from "./fix.js";
import { Exchange } from "./exchange.js";
import { MarketMaker, NoiseTrader } from "./bots.js";
import { Random } from "./random.js";

/** @typedef {import("./exchange.js").Trade} Trade */

export const SYMBOLS = {
  AAPL: { refPrice: 18724, name: "Apple" },
  MSFT: { refPrice: 41530, name: "Microsoft" },
  NVDA: { refPrice: 12840, name: "NVIDIA" },
};

export class Simulation {
  /**
   * @param {{ seed?: number, clock?: () => number, userCompId?: string, symbols?: Record<string, { refPrice: number }> }} [options]
   */
  constructor({ seed = 1, clock = Date.now, userCompId = "YOU", symbols = SYMBOLS } = {}) {
    this.userCompId = userCompId;
    this.symbols = Object.keys(symbols);
    this.exchange = new Exchange({ symbols, clock });
    const random = new Random(seed);
    this.random = random;
    this.maker = new MarketMaker({ compId: "MM-1", symbols, random, clock });
    this.traders = ["FLOW-1", "FLOW-2"].map((compId) => new NoiseTrader({ compId, random, clock }));
    this.tickCount = 0;
    /** @type {string[]} Raw messages that came back to bots, for diagnostics. */
    this.botInbox = [];

    for (const bot of [this.maker, ...this.traders]) this.#route(this.exchange.receive(bot.logon()));
    for (const symbol of this.symbols) this.#sendAll(this.maker.requote(symbol));
  }

  /**
   * Advances the market one tick: the maker refreshes one symbol's quotes, the noise
   * traders may cross the spread, and idle sessions get Heartbeats.
   *
   * @returns {{ toUser: string[], trades: Trade[] }}
   */
  step() {
    const symbol = this.symbols[this.tickCount++ % this.symbols.length];
    const result = this.#sendAll(this.maker.requote(symbol));

    for (const trader of this.traders) {
      if (!this.random.chance(0.35)) continue;
      const target = this.random.pick(this.symbols);
      const top = /** @type {import("./orderBook.js").OrderBook} */ (this.exchange.books.get(target)).top();
      const more = this.#sendAll(trader.trade(target, top));
      result.toUser.push(...more.toUser);
      result.trades.push(...more.trades);
    }

    result.toUser.push(...this.#route({ outbound: this.exchange.tick(), trades: [] }).toUser);
    return result;
  }

  /**
   * A message from the person using the app.
   *
   * @param {string} raw
   */
  submit(raw) {
    return this.#route(this.exchange.receive(raw));
  }

  /**
   * @param {string} symbol
   * @param {number} levels
   */
  snapshot(symbol, levels) {
    return this.exchange.snapshot(symbol, levels);
  }

  /** @param {string[]} messages */
  #sendAll(messages) {
    /** @type {{ toUser: string[], trades: Trade[] }} */
    const result = { toUser: [], trades: [] };
    for (const raw of messages) {
      const routed = this.#route(this.exchange.receive(raw));
      result.toUser.push(...routed.toUser);
      result.trades.push(...routed.trades);
    }
    return result;
  }

  /**
   * Hands the user's messages back to the caller; bots don't need their replies.
   *
   * @param {{ outbound: { to: string, raw: string }[], trades: Trade[] }} result
   */
  #route({ outbound, trades }) {
    /** @type {string[]} */
    const toUser = [];
    for (const { to, raw } of outbound) {
      if (to === this.userCompId) toUser.push(raw);
      else if (decode(raw).message.type === "3") this.botInbox.push(raw); // keep only problems
    }
    return { toUser, trades };
  }
}
