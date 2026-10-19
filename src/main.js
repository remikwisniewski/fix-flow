// The page is the FIX client. It owns the session (Logon, Heartbeats, sequence
// numbers), turns the ticket into NewOrderSingle messages, and rebuilds its view of
// every order from the ExecutionReports the exchange sends back.

import { decode } from "./engine/fix.js";
import { FixClient } from "./engine/session.js";
import { createBook } from "./ui/book.js";
import { createChart } from "./ui/chart.js";
import { createTape } from "./ui/tape.js";
import { createTicket } from "./ui/ticket.js";
import { createBlotter } from "./ui/blotter.js";
import { createInspector } from "./ui/inspector.js";
import { createToasts } from "./ui/toasts.js";
import { applyExecutionReport } from "./ui/orders.js";
import { escapeHtml, formatChange, formatQty, priceOrDash } from "./ui/format.js";

const HEARTBEAT_SECONDS = 10;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector) => document.querySelector(selector);

const client = new FixClient({ senderCompId: "YOU", targetCompId: "FIXFLOW" });
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

let lastTops = null;
let pendingPrice = true;

const state = {
  symbol: "AAPL",
  symbols: {},
  loggedOn: false,
  lastSentAt: 0,
  lastInSeq: 0,
  orders: new Map(),
  cancelIds: 1,
};

// ---------- Panels ----------

const toast = createToasts($("[data-toasts]"), { reducedMotion });
const inspector = createInspector({
  listEl: $("[data-messages]"),
  detailEl: $("[data-detail]"),
  filtersEl: $("[data-filters]"),
});
const chart = createChart($("[data-chart]"));
const tape = createTape($("[data-tape]"), { reducedMotion });
const ticket = createTicket({
  form: $("[data-ticket]"),
  wireEl: $("[data-wire]"),
  wireSizeEl: $("[data-wire-size]"),
  client,
  onSubmit: (request) => send(client.newOrder(request)),
});
const book = createBook({
  asksEl: $("[data-asks]"),
  bidsEl: $("[data-bids]"),
  spreadEl: $("[data-spread]"),
  symbolEl: $("[data-book-symbol]"),
  onPick: (price) => ticket.setPrice(price),
});
const blotter = createBlotter({
  listEl: $("[data-blotter]"),
  countEl: $("[data-blotter-count]"),
  reducedMotion,
  onCancel: (orderId) => {
    const order = state.orders.get(orderId);
    if (!order) return;
    send(
      client.cancel({
        clOrdId: `YOU-X${state.cancelIds++}`,
        origClOrdId: order.clOrdId,
        symbol: order.symbol,
        side: order.side,
      })
    );
  },
});

// ---------- Session ----------

function send(raw) {
  inspector.add("out", raw);
  worker.postMessage({ type: "fix", raw });
  state.lastSentAt = Date.now();
  renderSession();
}

function renderSession() {
  const el = $("[data-session]");
  el.dataset.state = state.loggedOn ? "on" : "off";
  $("[data-session-text]").textContent = state.loggedOn ? "Logged on as YOU" : "Logged out";
  $("[data-session-seq]").textContent = `out ${client.seq - 1} · in ${state.lastInSeq}`;
  $("[data-session-toggle]").textContent = state.loggedOn ? "Log out" : "Log on";
  ticket.setEnabled(state.loggedOn);
}

$("[data-session-toggle]").addEventListener("click", () => {
  send(state.loggedOn ? client.logout() : client.logon(HEARTBEAT_SECONDS));
});

// Keep the session alive: send a Heartbeat whenever we've been quiet for HeartBtInt.
setInterval(() => {
  if (state.loggedOn && Date.now() - state.lastSentAt >= HEARTBEAT_SECONDS * 1000) send(client.heartbeat());
}, 1000);

// ---------- Inbound FIX ----------

function receive(raw) {
  inspector.add("in", raw);
  const { ok, message } = decode(raw);
  if (!ok) return toast("Received a malformed message. See the inspector.", "error");
  state.lastInSeq = Number(message.get(34));

  switch (message.type) {
    case "A":
      state.loggedOn = true;
      toast(`Logged on. Heartbeat every ${message.get(108)}s.`);
      break;
    case "5":
      state.loggedOn = false;
      toast(message.get(58) ? `Logged out: ${message.get(58)}` : "Logged out.");
      break;
    case "3":
      toast(`Session reject: ${message.get(58)}`, "error");
      break;
    case "9":
      toast(`Cancel rejected: ${message.get(58)}`, "error");
      break;
    case "8": {
      const order = applyExecutionReport(state.orders, message);
      const exec = message.get(150);
      if (exec === "F") {
        toast(
          `${order.side === "buy" ? "Bought" : "Sold"} ${formatQty(Number(message.get(32)))} ${order.symbol} @ ${message.get(31)}`,
          "fill"
        );
      } else if (exec === "8") {
        toast(`Order rejected: ${message.get(58)}`, "error");
      }
      blotter.render(state.orders);
      break;
    }
  }
  renderSession();
}

// ---------- Market data ----------

function renderSymbols(tops) {
  const nav = $("[data-symbols]");
  nav.innerHTML = Object.entries(state.symbols)
    .map(([symbol, { name, refPrice }]) => {
      const last = tops?.[symbol]?.last ?? refPrice;
      const change = formatChange(last, refPrice);
      return `<button type="button" class="symbol-tab" data-symbol="${symbol}" aria-pressed="${symbol === state.symbol}">
          <span class="symbol-tab__ticker">${symbol}</span>
          <span class="symbol-tab__price num">${priceOrDash(last)}</span>
          <span class="symbol-tab__name">${escapeHtml(name)}</span>
          <span class="symbol-tab__change ${change.direction}">${change.text}</span>
        </button>`;
    })
    .join("");
}

$("[data-symbols]").addEventListener("click", (event) => {
  const tab = event.target.closest("[data-symbol]");
  if (!tab || tab.dataset.symbol === state.symbol) return;
  state.symbol = tab.dataset.symbol;
  pendingPrice = true; // the ticket price is refilled from the next snapshot
  worker.postMessage({ type: "subscribe", symbol: state.symbol });
  ticket.setSymbol(state.symbol, null);
  chart.show(state.symbol);
  tape.show(state.symbol);
  for (const el of document.querySelectorAll("[data-symbol]")) {
    el.setAttribute("aria-pressed", String(el.dataset.symbol === state.symbol));
  }
});

function onMarket({ book: snapshot, trades, tops }) {
  book.render(snapshot);
  chart.add(trades);
  tape.add(trades);
  $("[data-last-price]").textContent = `${state.symbol} last ${priceOrDash(snapshot.last)}`;

  if (pendingPrice && snapshot.symbol === state.symbol && snapshot.last !== null) {
    ticket.setSymbol(state.symbol, snapshot.last);
    pendingPrice = false;
  }

  // Redraw the tabs only when a price they show has changed.
  const key = JSON.stringify(Object.values(tops).map((t) => t.last));
  if (key !== lastTops) {
    lastTops = key;
    renderSymbols(tops);
  }
}

worker.onmessage = ({ data }) => {
  if (data.type === "ready") {
    state.symbols = data.symbols;
    renderSymbols(null);
    chart.show(state.symbol);
    tape.show(state.symbol);
    send(client.logon(HEARTBEAT_SECONDS));
  } else if (data.type === "fix") {
    receive(data.raw);
  } else if (data.type === "market") {
    if (data.book.symbol !== state.symbol) return; // a reply to an older subscription
    onMarket(data);
  }
};

renderSession();
