import { beforeEach, describe, expect, it } from "vitest";
import { OrderBook, crosses } from "../src/engine/orderBook.js";

let book;
let nextId = 0;
const limit = (side, price, qty, owner = "A") =>
  book.submit({ id: `o${++nextId}`, side, type: "limit", price, qty, owner });
const market = (side, qty, owner = "T") =>
  book.submit({ id: `o${++nextId}`, side, type: "market", price: null, qty, owner });

beforeEach(() => {
  book = new OrderBook("AAPL");
  nextId = 0;
});

describe("resting orders", () => {
  it("keeps bids best-first (highest) and asks best-first (lowest)", () => {
    limit("buy", 100, 1);
    limit("buy", 102, 1);
    limit("buy", 101, 1);
    limit("sell", 105, 1);
    limit("sell", 103, 1);
    limit("sell", 104, 1);

    expect(book.bids.map((l) => l.price)).toEqual([102, 101, 100]);
    expect(book.asks.map((l) => l.price)).toEqual([103, 104, 105]);
    expect(book.top()).toEqual({ bid: 102, ask: 103 });
  });

  it("queues orders at the same price in arrival order", () => {
    limit("buy", 100, 5, "first");
    limit("buy", 100, 7, "second");
    expect(book.bids).toHaveLength(1);
    expect(book.bids[0].queue.map((o) => o.owner)).toEqual(["first", "second"]);
  });

  it("aggregates depth per level", () => {
    limit("buy", 100, 5);
    limit("buy", 100, 7);
    limit("buy", 99, 1);
    expect(book.depth(1)).toEqual({ bids: [{ price: 100, qty: 12, orders: 2 }], asks: [] });
  });

  it("reports an empty book", () => {
    expect(book.top()).toEqual({ bid: null, ask: null });
  });
});

describe("matching", () => {
  it("does not trade when prices don't cross", () => {
    limit("sell", 101, 10);
    const result = limit("buy", 100, 10);
    expect(result).toEqual({ fills: [], remaining: 10, rested: true });
  });

  it("fills at the maker's price, not the taker's", () => {
    limit("sell", 100, 10, "maker");
    const { fills } = limit("buy", 105, 4, "taker");
    expect(fills).toEqual([{ makerId: "o1", makerOwner: "maker", price: 100, qty: 4, makerRemaining: 6 }]);
  });

  it("gives time priority to the earlier order at the same price", () => {
    limit("sell", 100, 5, "early");
    limit("sell", 100, 5, "late");
    const { fills } = limit("buy", 100, 7, "taker");
    expect(fills.map((f) => [f.makerOwner, f.qty])).toEqual([
      ["early", 5],
      ["late", 2],
    ]);
  });

  it("gives price priority over time priority", () => {
    limit("sell", 101, 5, "worse-but-earlier");
    limit("sell", 100, 5, "better");
    const { fills } = limit("buy", 101, 5, "taker");
    expect(fills[0].makerOwner).toBe("better");
  });

  it("sweeps several levels and rests the remainder at its limit", () => {
    limit("sell", 100, 3);
    limit("sell", 101, 3);
    limit("sell", 103, 3);
    const result = limit("buy", 101, 10, "taker");

    expect(result.fills.map((f) => [f.price, f.qty])).toEqual([
      [100, 3],
      [101, 3],
    ]);
    expect(result).toMatchObject({ remaining: 4, rested: true });
    expect(book.top()).toEqual({ bid: 101, ask: 103 });
  });

  it("removes fully filled makers and empty levels", () => {
    limit("sell", 100, 5);
    limit("buy", 100, 5);
    expect(book.asks).toEqual([]);
    expect(book.bids).toEqual([]);
    expect(book.get("o1")).toBeNull();
  });

  it("works the same way for sells hitting bids", () => {
    limit("buy", 100, 5);
    limit("buy", 99, 5);
    const { fills, remaining } = limit("sell", 99, 8);
    expect(fills.map((f) => [f.price, f.qty])).toEqual([
      [100, 5],
      [99, 3],
    ]);
    expect(remaining).toBe(0);
  });

  it("lets market orders take any price and never rest", () => {
    limit("sell", 100, 2);
    limit("sell", 250, 2);
    const result = market("buy", 10);
    expect(result.fills.map((f) => f.price)).toEqual([100, 250]);
    expect(result).toMatchObject({ remaining: 6, rested: false });
    expect(book.bids).toEqual([]);
  });

  it("returns a market order untouched when the book is empty", () => {
    expect(market("sell", 5)).toEqual({ fills: [], remaining: 5, rested: false });
  });
});

describe("cancel", () => {
  it("removes a resting order and its level if it was alone", () => {
    limit("buy", 100, 5);
    const canceled = book.cancel("o1");
    expect(canceled).toMatchObject({ id: "o1", remaining: 5 });
    expect(book.bids).toEqual([]);
  });

  it("keeps the rest of the queue in order", () => {
    limit("buy", 100, 1, "a");
    limit("buy", 100, 1, "b");
    limit("buy", 100, 1, "c");
    book.cancel("o2");
    expect(book.bids[0].queue.map((o) => o.owner)).toEqual(["a", "c"]);
  });

  it("returns null for unknown or already filled orders", () => {
    limit("sell", 100, 1);
    limit("buy", 100, 1);
    expect(book.cancel("o1")).toBeNull();
    expect(book.cancel("nope")).toBeNull();
  });

  it("cancels the remaining quantity after a partial fill", () => {
    limit("sell", 100, 10);
    limit("buy", 100, 4);
    expect(book.cancel("o1")).toMatchObject({ remaining: 6 });
  });
});

describe("validation", () => {
  it.each([0, -1, 1.5])("rejects qty %s", (qty) => {
    expect(() => limit("buy", 100, qty)).toThrow("positive integer");
  });

  it("rejects a limit order without a price", () => {
    expect(() =>
      book.submit({ id: "x", side: "buy", type: "limit", price: null, qty: 1, owner: "A" })
    ).toThrow("need a price");
  });

  it("rejects a duplicate id that is still resting", () => {
    limit("buy", 100, 1);
    expect(() =>
      book.submit({ id: "o1", side: "buy", type: "limit", price: 100, qty: 1, owner: "A" })
    ).toThrow("duplicate");
  });
});

describe("crosses", () => {
  it.each([
    ["buy", 100, 100, true],
    ["buy", 100, 101, false],
    ["sell", 100, 100, true],
    ["sell", 100, 99, false],
  ])("%s at %i vs level %i → %s", (side, limitPrice, level, expected) => {
    expect(crosses(side, limitPrice, level)).toBe(expected);
  });
});
