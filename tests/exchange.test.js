import { beforeEach, describe, expect, it } from "vitest";
import { Exchange, MAX_ORDER_QTY, averagePrice } from "../src/engine/exchange.js";
import { decode, encode, fromDisplay, toDisplay } from "../src/engine/fix.js";
import { FixClient } from "../src/engine/session.js";

const START = Date.UTC(2026, 9, 19, 14, 30, 0);
let now;
let exchange;
let alice;
let bob;

/** Sends a raw message and returns every reply decoded, grouped by recipient. */
const send = (raw) => {
  const { outbound, trades } = exchange.receive(raw);
  const replies = outbound.map(({ to, raw: reply }) => {
    const result = decode(reply);
    expect(result.ok).toBe(true); // every message the exchange sends must be well-formed
    return { to, msg: result.message };
  });
  return { replies, trades, to: (who) => replies.filter((r) => r.to === who).map((r) => r.msg) };
};

const order = (client, overrides = {}) =>
  client.newOrder({
    clOrdId: `C${client.seq}`,
    symbol: "AAPL",
    side: "buy",
    type: "limit",
    price: 18700,
    qty: 100,
    ...overrides,
  });

beforeEach(() => {
  now = START;
  const clock = () => now;
  exchange = new Exchange({ symbols: { AAPL: { refPrice: 18700 }, MSFT: { refPrice: 41500 } }, clock });
  alice = new FixClient({ senderCompId: "ALICE", targetCompId: "FIXFLOW", clock });
  bob = new FixClient({ senderCompId: "BOB", targetCompId: "FIXFLOW", clock });
  send(alice.logon(5));
  send(bob.logon(5));
});

describe("session layer", () => {
  it("answers a Logon with a Logon echoing HeartBtInt", () => {
    const fresh = new FixClient({ senderCompId: "CAROL", targetCompId: "FIXFLOW", clock: () => now });
    const [reply] = send(fresh.logon(15)).to("CAROL");
    expect(reply.type).toBe("A");
    expect(reply.get(108)).toBe("15");
    expect(reply.get(34)).toBe("1");
    expect(reply.get(49)).toBe("FIXFLOW");
    expect(reply.get(56)).toBe("CAROL");
  });

  it("logs out a client whose first message isn't a Logon", () => {
    const stranger = new FixClient({ senderCompId: "EVE", targetCompId: "FIXFLOW" });
    stranger.seq = 2;
    const [reply] = send(order(stranger)).to("EVE");
    expect(reply.type).toBe("5");
    expect(reply.get(58)).toBe("First message must be Logon");
  });

  it("requires a positive HeartBtInt", () => {
    const client = new FixClient({ senderCompId: "CAROL", targetCompId: "FIXFLOW" });
    const [reply] = send(client.logon(0)).to("CAROL");
    expect(reply.type).toBe("5");
    expect(exchange.sessions.get("CAROL").loggedOn).toBe(false);
  });

  it("rejects a corrupted message, quoting the framing error", () => {
    const raw = toDisplay(alice.heartbeat()).replace(/10=\d{3}/, "10=000");
    const [reply] = send(fromDisplay(raw)).to("ALICE");
    expect(reply.type).toBe("3");
    expect(reply.get(58)).toMatch(/^CheckSum is 000/);
    expect(reply.get(45)).toBe("2");
  });

  it("ignores a message with no SenderCompID, since there is nobody to answer", () => {
    expect(send(encode([[35, "0"]])).replies).toEqual([]);
  });

  it("rejects the wrong TargetCompID", () => {
    const lost = new FixClient({ senderCompId: "ALICE", targetCompId: "OTHER", clock: () => now });
    lost.seq = 2;
    const [reply] = send(lost.heartbeat()).to("ALICE");
    expect(reply.type).toBe("3");
    expect(reply.get(373)).toBe("9");
  });

  it("rejects a missing MsgSeqNum", () => {
    const raw = encode([
      [35, "0"],
      [49, "ALICE"],
      [56, "FIXFLOW"],
    ]);
    const [reply] = send(raw).to("ALICE");
    expect(reply.get(373)).toBe("1");
    expect(reply.get(371)).toBe("34");
  });

  it("enforces sequence numbers and resynchronises after a gap", () => {
    alice.seq = 5; // skipped 2-4
    const [gap] = send(alice.heartbeat()).to("ALICE");
    expect(gap.type).toBe("3");
    expect(gap.get(58)).toBe("MsgSeqNum too high: expected 2, got 5");

    expect(send(alice.heartbeat()).replies).toEqual([]); // 6 is now in sequence

    alice.seq = 3;
    expect(send(alice.heartbeat()).to("ALICE")[0].get(58)).toBe("MsgSeqNum too low: expected 7, got 3");
  });

  it("numbers its own messages per session", () => {
    const seqs = [send(order(alice)), send(order(alice))].flatMap((r) => r.to("ALICE").map((m) => m.get(34)));
    expect(seqs).toEqual(["2", "3"]);
  });

  it("answers a TestRequest with a Heartbeat carrying the same TestReqID", () => {
    const [reply] = send(alice.send("1", [[112, "PING-1"]])).to("ALICE");
    expect(reply.type).toBe("0");
    expect(reply.get(112)).toBe("PING-1");
  });

  it("acknowledges a Logout and stops accepting orders", () => {
    expect(send(alice.logout()).to("ALICE")[0].type).toBe("5");
    expect(send(order(alice)).to("ALICE")[0].get(58)).toBe("First message must be Logon");
  });

  it("rejects message types it doesn't support", () => {
    const [reply] = send(alice.send("V")).to("ALICE");
    expect(reply.get(373)).toBe("11");
  });

  it("sends Heartbeats only to sessions that have been quiet for HeartBtInt", () => {
    expect(exchange.tick()).toEqual([]);
    now += 5_000;
    send(order(bob)); // Bob just heard from us
    const beats = exchange.tick().map((o) => [o.to, decode(o.raw).message.type]);
    expect(beats).toEqual([["ALICE", "0"]]);
  });
});

describe("new orders", () => {
  it("acknowledges a resting limit order", () => {
    const [ack] = send(order(alice, { clOrdId: "A1" })).to("ALICE");
    expect(ack.type).toBe("8");
    expect(Object.fromEntries([11, 150, 39, 151, 14, 44].map((t) => [t, ack.get(t)]))).toEqual({
      11: "A1",
      150: "0",
      39: "0",
      151: "100",
      14: "0",
      44: "187.00",
    });
    expect(exchange.snapshot("AAPL", 5).bids).toEqual([{ price: 18700, qty: 100, orders: 1 }]);
  });

  it("fills both sides and reports trades to each owner", () => {
    send(order(alice, { side: "sell", price: 18710, qty: 100, clOrdId: "ASK" }));
    const result = send(order(bob, { side: "buy", price: 18720, qty: 60, clOrdId: "BID" }));

    expect(result.trades).toEqual([
      { symbol: "AAPL", price: 18710, qty: 60, aggressor: "buy", buyer: "BOB", seller: "ALICE", time: START },
    ]);

    const [bobAck, bobFill] = result.to("BOB");
    expect(bobAck.get(150)).toBe("0");
    expect([bobFill.get(150), bobFill.get(39), bobFill.get(32), bobFill.get(31), bobFill.get(151)]).toEqual([
      "F",
      "2",
      "60",
      "187.10",
      "0",
    ]);

    const [aliceFill] = result.to("ALICE");
    expect([aliceFill.get(11), aliceFill.get(39), aliceFill.get(14), aliceFill.get(151)]).toEqual([
      "ASK",
      "1",
      "60",
      "40",
    ]);
    expect(exchange.snapshot("AAPL", 1).last).toBe(18710);
  });

  it("reports a volume-weighted average price across fills", () => {
    send(order(alice, { side: "sell", price: 18700, qty: 1, clOrdId: "S1" }));
    send(order(alice, { side: "sell", price: 18701, qty: 2, clOrdId: "S2" }));
    const fills = send(order(bob, { type: "market", qty: 3 })).to("BOB");
    expect(fills.at(-1).get(6)).toBe("187.0067"); // (187.00 + 2 × 187.01) / 3
  });

  it("cancels the unfilled part of a market order", () => {
    send(order(alice, { side: "sell", price: 18700, qty: 10 }));
    const replies = send(order(bob, { type: "market", qty: 25 })).to("BOB");
    const last = replies.at(-1);
    expect([last.get(150), last.get(39), last.get(14), last.get(151)]).toEqual(["4", "4", "10", "0"]);
    expect(last.get(58)).toBe("No liquidity for the remaining quantity");
  });

  it("cancels the unfilled part of an IOC limit order instead of resting it", () => {
    send(order(alice, { side: "sell", price: 18700, qty: 10 }));
    const replies = send(order(bob, { price: 18705, qty: 25, tif: "ioc" })).to("BOB");
    expect(replies.at(-1).get(39)).toBe("4");
    expect(exchange.snapshot("AAPL", 5).bids).toEqual([]);
  });

  it.each([
    ["an unknown symbol", { symbol: "ZZZZ" }, "Unknown symbol ZZZZ"],
    ["zero quantity", { qty: 0 }, "OrderQty must be a positive whole number"],
    ["a fat-finger quantity", { qty: MAX_ORDER_QTY + 1 }, "exceeds the 100,000 share limit"],
    ["a price far from the market", { price: 30000 }, "more than 20% away from the last trade (187.00)"],
    ["a zero price", { price: 0 }, "must be a positive number"],
  ])("rejects %s with an ExecutionReport", (_, overrides, text) => {
    const [reply] = send(order(alice, overrides)).to("ALICE");
    expect([reply.type, reply.get(150), reply.get(39)]).toEqual(["8", "8", "8"]);
    expect(reply.get(58)).toContain(text);
  });

  it("rejects a malformed price", () => {
    const raw = alice.send("D", [
      [11, "X"],
      [55, "AAPL"],
      [54, "1"],
      [38, "10"],
      [40, "2"],
      [44, "1.234"],
    ]);
    expect(send(raw).to("ALICE")[0].get(58)).toContain('Price (44) "1.234"');
  });

  it("rejects a reused ClOrdID", () => {
    send(order(alice, { clOrdId: "SAME" }));
    expect(
      send(order(alice, { clOrdId: "SAME" }))
        .to("ALICE")[0]
        .get(58)
    ).toBe("Duplicate ClOrdID SAME");
  });

  it("lets different clients use the same ClOrdID", () => {
    send(order(alice, { clOrdId: "SAME" }));
    expect(
      send(order(bob, { clOrdId: "SAME" }))
        .to("BOB")[0]
        .get(39)
    ).toBe("0");
  });

  it.each([
    [54, "7", "5"],
    [40, "9", "5"],
  ])("session-rejects tag %i = %s", (tag, value, reason) => {
    const fields = new Map([
      [11, "X"],
      [55, "AAPL"],
      [54, "1"],
      [38, "10"],
      [40, "2"],
      [44, "187.00"],
    ]);
    fields.set(tag, value);
    const [reply] = send(alice.send("D", [...fields])).to("ALICE");
    expect([reply.type, reply.get(373), reply.get(371)]).toEqual(["3", reason, String(tag)]);
  });

  it("session-rejects a NewOrderSingle with a required tag missing", () => {
    const [reply] = send(
      alice.send("D", [
        [11, "X"],
        [55, "AAPL"],
      ])
    ).to("ALICE");
    expect([reply.type, reply.get(373), reply.get(371)]).toEqual(["3", "1", "54"]);
  });
});

describe("cancels", () => {
  it("cancels a resting order and switches to the new ClOrdID", () => {
    send(order(alice, { clOrdId: "A1" }));
    const [reply] = send(
      alice.cancel({ clOrdId: "A1-X", origClOrdId: "A1", symbol: "AAPL", side: "buy" })
    ).to("ALICE");
    expect([reply.get(150), reply.get(39), reply.get(11), reply.get(41), reply.get(151)]).toEqual([
      "4",
      "4",
      "A1-X",
      "A1",
      "0",
    ]);
    expect(exchange.snapshot("AAPL", 5).bids).toEqual([]);
  });

  it("cancels what's left after a partial fill", () => {
    send(order(alice, { clOrdId: "A1", qty: 100 }));
    send(order(bob, { side: "sell", price: 18700, qty: 30 }));
    const [reply] = send(
      alice.cancel({ clOrdId: "A1-X", origClOrdId: "A1", symbol: "AAPL", side: "buy" })
    ).to("ALICE");
    expect([reply.get(14), reply.get(151)]).toEqual(["30", "0"]);
  });

  it("refuses to cancel an unknown order", () => {
    const [reply] = send(
      alice.cancel({ clOrdId: "X2", origClOrdId: "NOPE", symbol: "AAPL", side: "buy" })
    ).to("ALICE");
    expect([reply.type, reply.get(102), reply.get(37), reply.get(58)]).toEqual([
      "9",
      "1",
      "NONE",
      "Unknown order",
    ]);
  });

  it("refuses to cancel another client's order", () => {
    send(order(alice, { clOrdId: "MINE" }));
    expect(
      send(bob.cancel({ clOrdId: "X", origClOrdId: "MINE", symbol: "AAPL", side: "buy" })).to("BOB")[0].type
    ).toBe("9");
  });

  it("refuses to cancel a filled order", () => {
    send(order(alice, { clOrdId: "A1", qty: 10 }));
    send(order(bob, { side: "sell", price: 18700, qty: 10 }));
    const [reply] = send(
      alice.cancel({ clOrdId: "A1-X", origClOrdId: "A1", symbol: "AAPL", side: "buy" })
    ).to("ALICE");
    expect([reply.type, reply.get(102), reply.get(39), reply.get(58)]).toEqual([
      "9",
      "0",
      "2",
      "Order is already filled",
    ]);
  });

  it("refuses to cancel twice", () => {
    send(order(alice, { clOrdId: "A1" }));
    send(alice.cancel({ clOrdId: "A1-X", origClOrdId: "A1", symbol: "AAPL", side: "buy" }));
    const [reply] = send(
      alice.cancel({ clOrdId: "A1-Y", origClOrdId: "A1-X", symbol: "AAPL", side: "buy" })
    ).to("ALICE");
    expect(reply.get(58)).toBe("Order is already closed");
  });

  it("session-rejects a cancel with a required tag missing", () => {
    const [reply] = send(alice.send("F", [[11, "X"]])).to("ALICE");
    expect([reply.type, reply.get(371)]).toEqual(["3", "41"]);
  });
});

describe("market data", () => {
  it("throws for an unknown symbol", () => {
    expect(() => exchange.snapshot("NOPE", 5)).toThrow("Unknown symbol NOPE");
  });

  it("keeps books per symbol", () => {
    send(order(alice, { symbol: "MSFT", price: 41500 }));
    expect(exchange.snapshot("AAPL", 5).bids).toEqual([]);
    expect(exchange.snapshot("MSFT", 5).bids).toHaveLength(1);
  });
});

describe("averagePrice", () => {
  it.each([
    [{ cumQty: 0, notional: 0 }, "0"],
    [{ cumQty: 2, notional: 37400 }, "187.00"],
    [{ cumQty: 3, notional: 56106 }, "187.02"],
    [{ cumQty: 3, notional: 56102 }, "187.0067"],
  ])("%j → %s", (order, expected) => {
    expect(averagePrice(order)).toBe(expected);
  });
});
