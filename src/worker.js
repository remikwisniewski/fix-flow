// The exchange runs here, off the main thread. postMessage is the "wire": the page
// sends raw FIX in and gets raw FIX back, plus a market data feed for the displays.

import { SYMBOLS, Simulation } from "./engine/simulation.js";

const TICK_MS = 300;
const DEPTH = 10;

const sim = new Simulation({ seed: Date.now() % 2 ** 31 });
let symbol = "AAPL";

const tops = () =>
  Object.fromEntries(
    sim.symbols.map((s) => {
      const { bid, ask } = sim.exchange.books.get(s).top();
      return [s, { last: sim.exchange.lastPrice.get(s), bid, ask }];
    })
  );

function publish({ toUser, trades }) {
  for (const raw of toUser) postMessage({ type: "fix", raw });
  postMessage({ type: "market", book: sim.snapshot(symbol, DEPTH), trades, tops: tops() });
}

self.onmessage = ({ data }) => {
  if (data.type === "fix") publish(sim.submit(data.raw));
  if (data.type === "subscribe" && SYMBOLS[data.symbol]) {
    symbol = data.symbol;
    publish({ toUser: [], trades: [] });
  }
};

postMessage({ type: "ready", symbols: SYMBOLS });
setInterval(() => publish(sim.step()), TICK_MS);
