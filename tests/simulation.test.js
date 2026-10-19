import { describe, expect, it } from "vitest";
import { SYMBOLS, Simulation } from "../src/engine/simulation.js";
import { Random, mulberry32 } from "../src/engine/random.js";
import { MarketMaker, NoiseTrader } from "../src/engine/bots.js";
import { decode } from "../src/engine/fix.js";
import { FixClient } from "../src/engine/session.js";

// Whole-market runs are CPU-bound; CI runners with coverage on are several times
// slower than a laptop, so these tests get an explicit budget instead of the 5s default.
const SLOW = 20_000;

const run = (seed, steps) => {
  let now = Date.UTC(2026, 9, 19, 14, 30);
  const sim = new Simulation({ seed, clock: () => now });
  const trades = [];
  for (let i = 0; i < steps; i++) {
    now += 250;
    trades.push(...sim.step().trades);
  }
  return { sim, trades, advance: (ms) => (now += ms) };
};

describe("Random", () => {
  it("is deterministic for a seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("keeps helpers within their bounds", () => {
    const random = new Random(7);
    for (let i = 0; i < 1000; i++) {
      const n = random.int(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      expect(["x", "y"]).toContain(random.pick(["x", "y"]));
    }
  });

  it("produces a roughly standard normal distribution", () => {
    const random = new Random(3);
    const samples = Array.from({ length: 5000 }, () => random.gaussian());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
  });

  it("returns true from chance() at about the requested rate", () => {
    const random = new Random(11);
    const hits = Array.from({ length: 4000 }, () => random.chance(0.25)).filter(Boolean).length;
    expect(hits / 4000).toBeCloseTo(0.25, 1);
  });
});

describe("Simulation", () => {
  it("builds a two-sided market for every symbol at start-up", () => {
    const { sim } = run(1, 0);
    for (const symbol of sim.symbols) {
      const { bids, asks } = sim.snapshot(symbol, 6);
      expect(bids.length).toBeGreaterThan(0);
      expect(asks.length).toBeGreaterThan(0);
      expect(bids[0].price).toBeLessThan(asks[0].price);
    }
  });

  it(
    "prints trades and keeps every book uncrossed",
    () => {
      const { sim, trades } = run(2, 400);
      expect(trades.length).toBeGreaterThan(50);
      for (const symbol of sim.symbols) {
        const { bids, asks } = sim.snapshot(symbol, 1);
        if (bids.length && asks.length) expect(bids[0].price).toBeLessThan(asks[0].price);
      }
    },
    SLOW
  );

  it(
    "never sends a malformed message: the gateway rejects nothing from the bots",
    () => {
      const { sim } = run(3, 400);
      expect(sim.botInbox.map((raw) => decode(raw).message.get(58))).toEqual([]);
    },
    SLOW
  );

  it(
    "keeps prices near their reference over a long run",
    () => {
      const { sim } = run(4, 1200);
      for (const symbol of sim.symbols) {
        const last = sim.snapshot(symbol, 1).last;
        const ref = SYMBOLS[symbol].refPrice;
        expect(Math.abs(last - ref) / ref).toBeLessThan(0.1);
      }
    },
    SLOW
  );

  it(
    "is reproducible from the same seed",
    () => {
      const a = run(9, 200).trades.map((t) => [t.symbol, t.price, t.qty]);
      const b = run(9, 200).trades.map((t) => [t.symbol, t.price, t.qty]);
      expect(a).toEqual(b);
    },
    SLOW
  );

  it("routes only the user's replies back to the user", () => {
    let now = Date.UTC(2026, 9, 19, 14, 30);
    const sim = new Simulation({ seed: 5, clock: () => now });
    const you = new FixClient({ senderCompId: "YOU", targetCompId: "FIXFLOW", clock: () => now });

    const [logon] = sim.submit(you.logon(10)).toUser;
    expect(decode(logon).message.type).toBe("A");

    const top = sim.exchange.books.get("AAPL").top();
    const { toUser, trades } = sim.submit(
      you.newOrder({ clOrdId: "Y1", symbol: "AAPL", side: "buy", type: "limit", price: top.ask, qty: 100 })
    );
    expect(toUser.every((raw) => decode(raw).message.get(56) === "YOU")).toBe(true);
    expect(trades.length).toBeGreaterThan(0);

    now += 10_000;
    const beats = sim.step().toUser.map((raw) => decode(raw).message.type);
    expect(beats).toContain("0");
  });
});

describe("bots", () => {
  it("market maker cancels its previous quotes before re-quoting", () => {
    const maker = new MarketMaker({
      compId: "MM",
      symbols: { AAPL: { refPrice: 10000 } },
      random: new Random(1),
    });
    const first = maker.requote("AAPL").map((raw) => decode(raw).message.type);
    const second = maker.requote("AAPL").map((raw) => decode(raw).message.type);
    expect(first.every((t) => t === "D")).toBe(true);
    expect(second.filter((t) => t === "F")).toHaveLength(first.length);
  });

  it("market maker quotes bids below asks", () => {
    const maker = new MarketMaker({
      compId: "MM",
      symbols: { AAPL: { refPrice: 10000 } },
      random: new Random(2),
    });
    const quotes = maker.requote("AAPL").map((raw) => decode(raw).message);
    const bids = quotes.filter((m) => m.get(54) === "1").map((m) => Number(m.get(44)));
    const asks = quotes.filter((m) => m.get(54) === "2").map((m) => Number(m.get(44)));
    expect(Math.max(...bids)).toBeLessThan(Math.min(...asks));
  });

  it("noise trader sends market orders when the other side is empty", () => {
    const trader = new NoiseTrader({ compId: "NT", random: new Random(1) });
    for (let i = 0; i < 20; i++) {
      const [raw] = trader.trade("AAPL", { bid: null, ask: null });
      expect(decode(raw).message.get(40)).toBe("1");
    }
  });

  it("noise trader's limit orders are IOC so they never clutter the book", () => {
    const trader = new NoiseTrader({ compId: "NT", random: new Random(2) });
    const limits = Array.from(
      { length: 50 },
      () => decode(trader.trade("AAPL", { bid: 9999, ask: 10001 })[0]).message
    ).filter((m) => m.get(40) === "2");
    expect(limits.length).toBeGreaterThan(0);
    expect(limits.every((m) => m.get(59) === "3")).toBe(true);
  });
});
