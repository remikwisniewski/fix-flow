// Order book ladder: asks above the spread, bids below, with depth bars scaled to
// the largest visible level. Clicking a level sends its price to the ticket.

import { formatPrice } from "../engine/fix.js";
import { formatQty, priceOrDash } from "./format.js";

const ROWS = 10;

export function createBook({ asksEl, bidsEl, spreadEl, symbolEl, onPick }) {
  let previous = new Map();

  const row = (level, side, max) => {
    const key = `${side}:${level.price}`;
    const changed = previous.has(key) && previous.get(key) !== level.qty;
    const depth = Math.round((level.qty / max) * 100);
    return `<button type="button" class="level level--${side}${changed ? " is-flash" : ""}"
        style="--depth:${depth}%" data-price="${level.price}" role="row"
        aria-label="${side === "ask" ? "Ask" : "Bid"} ${formatPrice(level.price)}, ${formatQty(level.qty)} shares">
      <span class="level__price" role="cell">${formatPrice(level.price)}</span>
      <span role="cell">${formatQty(level.qty)}</span>
      <span class="level__orders" role="cell">${level.orders}</span>
    </button>`;
  };

  for (const el of [asksEl, bidsEl]) {
    el.addEventListener("click", (event) => {
      const level = event.target.closest("[data-price]");
      if (level) onPick(Number(level.dataset.price));
    });
  }

  return {
    render({ symbol, bids, asks, last }) {
      const visibleAsks = asks.slice(0, ROWS);
      const visibleBids = bids.slice(0, ROWS);
      const max = Math.max(1, ...visibleAsks.map((l) => l.qty), ...visibleBids.map((l) => l.qty));

      asksEl.innerHTML = visibleAsks
        .slice()
        .reverse()
        .map((l) => row(l, "ask", max))
        .join("");
      bidsEl.innerHTML = visibleBids.map((l) => row(l, "bid", max)).join("");

      const spread = bids[0] && asks[0] ? formatPrice(asks[0].price - bids[0].price) : "—";
      spreadEl.innerHTML = `<span class="ladder__last num">${priceOrDash(last)}</span>
        <span class="ladder__spread-size">Spread ${spread}</span>`;
      symbolEl.textContent = symbol;

      previous = new Map([
        ...visibleAsks.map((l) => [`ask:${l.price}`, l.qty]),
        ...visibleBids.map((l) => [`bid:${l.price}`, l.qty]),
      ]);
    },
  };
}
