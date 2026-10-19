import { describe, expect, it } from "vitest";
import { Exchange } from "../src/engine/exchange.js";
import { decode, encode, fromDisplay, parse } from "../src/engine/fix.js";
import { FixClient } from "../src/engine/session.js";
import { STATUS_LABELS, applyExecutionReport, isOpen } from "../src/ui/orders.js";
import {
  category,
  escapeHtml,
  formatChange,
  formatClock,
  formatQty,
  highlightRaw,
  priceOrDash,
  summarize,
} from "../src/ui/format.js";

/** A logged-on client and a counterparty, wired to a fresh exchange. */
function setup() {
  const now = () => Date.UTC(2026, 9, 19, 14, 30);
  const exchange = new Exchange({ symbols: { AAPL: { refPrice: 18700 } }, clock: now });
  const you = new FixClient({ senderCompId: "YOU", targetCompId: "FIXFLOW", clock: now });
  const them = new FixClient({ senderCompId: "THEM", targetCompId: "FIXFLOW", clock: now });
  exchange.receive(you.logon(10));
  exchange.receive(them.logon(10));
  const reportsFor = (raw, who = "YOU") =>
    exchange
      .receive(raw)
      .outbound.filter((o) => o.to === who)
      .map((o) => decode(o.raw).message)
      .filter((m) => m.type === "8");
  return { you, them, reportsFor };
}

describe("applyExecutionReport", () => {
  it("builds the order from its acknowledgement", () => {
    const { you, reportsFor } = setup();
    const orders = new Map();
    const [ack] = reportsFor(
      you.newOrder({ clOrdId: "Y1", symbol: "AAPL", side: "buy", type: "limit", price: 18700, qty: 300 })
    );
    const order = applyExecutionReport(orders, ack);

    expect(order).toMatchObject({
      clOrdId: "Y1",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      price: "187.00",
      qty: 300,
      cumQty: 0,
      leavesQty: 300,
      status: "0",
      fills: [],
    });
    expect(isOpen(order)).toBe(true);
    expect(orders.size).toBe(1);
  });

  it("tracks partial fills, then the final fill", () => {
    const { you, them, reportsFor } = setup();
    const orders = new Map();
    reportsFor(
      you.newOrder({ clOrdId: "Y1", symbol: "AAPL", side: "buy", type: "limit", price: 18700, qty: 300 })
    ).forEach((r) => applyExecutionReport(orders, r));

    const sell = (qty, n) =>
      reportsFor(
        them.newOrder({ clOrdId: `T${n}`, symbol: "AAPL", side: "sell", type: "market", qty })
      ).forEach((r) => applyExecutionReport(orders, r));

    sell(100, 1);
    const order = [...orders.values()][0];
    expect([order.status, order.cumQty, order.leavesQty]).toEqual(["1", 100, 200]);

    sell(200, 2);
    expect([order.status, order.cumQty, order.leavesQty, isOpen(order)]).toEqual(["2", 300, 0, false]);
    expect(order.fills).toEqual([
      { qty: 100, price: "187.00" },
      { qty: 200, price: "187.00" },
    ]);
  });

  it("records the reason for a reject", () => {
    const { you, reportsFor } = setup();
    const orders = new Map();
    const [reject] = reportsFor(
      you.newOrder({ clOrdId: "Y1", symbol: "ZZZ", side: "sell", type: "market", qty: 1 })
    );
    const order = applyExecutionReport(orders, reject);
    expect([order.status, order.text, order.side, order.type, order.price]).toEqual([
      "8",
      "Unknown symbol ZZZ",
      "sell",
      "market",
      null,
    ]);
  });

  it("follows the new ClOrdID after a cancel", () => {
    const { you, reportsFor } = setup();
    const orders = new Map();
    reportsFor(
      you.newOrder({ clOrdId: "Y1", symbol: "AAPL", side: "buy", type: "limit", price: 18700, qty: 5 })
    ).forEach((r) => applyExecutionReport(orders, r));
    const [canceled] = reportsFor(
      you.cancel({ clOrdId: "Y1-X", origClOrdId: "Y1", symbol: "AAPL", side: "buy" })
    );
    const order = applyExecutionReport(orders, canceled);
    expect([order.clOrdId, order.status, STATUS_LABELS[order.status]]).toEqual(["Y1-X", "4", "Canceled"]);
  });

  it("refuses anything that isn't an ExecutionReport", () => {
    expect(() => applyExecutionReport(new Map(), parse(encode([[35, "0"]])))).toThrow(
      "Expected an ExecutionReport"
    );
  });
});

describe("summarize", () => {
  const msg = (display) => parse(fromDisplay(display));

  it.each([
    ["35=A|108=10|", "Logon · HeartBtInt 10s"],
    ["35=0|", "Heartbeat"],
    ["35=0|112=PING|", "Heartbeat · TestReqID PING"],
    ["35=5|", "Logout"],
    ["35=5|58=Bye|", "Logout · Bye"],
    ["35=3|58=Bad seq|", "Reject · Bad seq"],
    ["35=D|54=1|38=1200|55=AAPL|40=2|44=187.24|", "Buy 1,200 AAPL @ 187.24"],
    ["35=D|54=2|38=100|55=MSFT|40=1|59=3|", "Sell 100 MSFT @ market IOC"],
    ["35=F|41=Y1|", "Cancel Y1"],
    ["35=9|58=Unknown order|", "Cancel rejected · Unknown order"],
    ["35=8|150=0|54=1|38=100|55=AAPL|40=2|44=187.00|", "New · Buy 100 AAPL @ 187.00"],
    ["35=8|150=F|39=1|32=40|31=187.10|", "Partial fill 40 @ 187.10"],
    ["35=8|150=F|39=2|32=60|31=187.10|", "Filled 60 @ 187.10"],
    ["35=8|150=4|", "Canceled"],
    ["35=8|150=4|58=No liquidity|", "Canceled · No liquidity"],
    ["35=8|150=8|58=Unknown symbol|", "Rejected · Unknown symbol"],
    ["35=8|150=Z|", "ExecutionReport"],
    ["35=V|", "Unknown (V)"],
  ])("%s → %s", (display, expected) => {
    expect(summarize(msg(display))).toBe(expected);
  });
});

describe("category", () => {
  it.each([
    ["D", "orders"],
    ["F", "orders"],
    ["8", "executions"],
    ["9", "executions"],
    ["A", "session"],
    ["0", "session"],
  ])("35=%s → %s", (type, expected) => {
    expect(category(type)).toBe(expected);
  });
});

describe("formatting", () => {
  it("formats quantities with thousands separators", () => {
    expect(formatQty(1234567)).toBe("1,234,567");
  });

  it("shows UTC clock time", () => {
    expect(formatClock(Date.UTC(2026, 9, 19, 9, 5, 7))).toBe("09:05:07");
  });

  it.each([
    [18900, 18700, { text: "+1.07%", direction: "up" }],
    [18500, 18700, { text: "-1.07%", direction: "down" }],
    [18700, 18700, { text: "0.00%", direction: "flat" }],
    [18701, 18700, { text: "+0.01%", direction: "up" }],
  ])("change %i vs %i", (last, ref, expected) => {
    expect(formatChange(last, ref)).toEqual(expected);
  });

  it("shows a dash for a missing price", () => {
    expect(priceOrDash(null)).toBe("—");
    expect(priceOrDash(18724)).toBe("187.24");
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<b a="1">'&'</b>`)).toBe("&lt;b a=&quot;1&quot;&gt;&#39;&amp;&#39;&lt;/b&gt;");
    expect(escapeHtml(null)).toBe("");
  });
});

describe("highlightRaw", () => {
  it("wraps tags and values, dims framing tags, and shows SOH as |", () => {
    const html = highlightRaw(fromDisplay("8=FIX.4.4|35=D|58=<x>|10=001|"));
    expect(html).toContain('<span class="tag tag--frame">8</span>=<span class="val">FIX.4.4</span>');
    expect(html).toContain(
      '<span class="tag">35</span>=<span class="val">D</span><span class="soh">|</span>'
    );
    expect(html).toContain("&lt;x&gt;");
    expect(html).not.toContain("\x01");
  });

  it("handles a field with no '='", () => {
    expect(highlightRaw(fromDisplay("junk|"))).toContain(
      '<span class="tag">junk</span>=<span class="val"></span>'
    );
  });
});
