// Time and sales: the most recent prints for the selected symbol, newest first.

import { gsap } from "gsap";
import { formatPrice } from "../engine/fix.js";
import { formatClock, formatQty } from "./format.js";

const ROWS = 11;

export function createTape(listEl, { reducedMotion }) {
  const history = new Map();
  let symbol = null;

  const row = (t) => `<li class="tape__row">
      <span>${formatClock(t.time)}</span>
      <span class="${t.aggressor === "buy" ? "up" : "down"}">${formatPrice(t.price)}</span>
      <span>${formatQty(t.qty)}</span>
    </li>`;

  const render = (fresh = 0) => {
    listEl.innerHTML = (history.get(symbol) ?? []).map(row).join("");
    if (fresh && !reducedMotion) {
      gsap.from([...listEl.children].slice(0, fresh), {
        backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--flash").trim(),
        duration: 0.8,
        ease: "power2.out",
      });
    }
  };

  return {
    add(trades) {
      let fresh = 0;
      for (const trade of trades) {
        const list = history.get(trade.symbol) ?? [];
        list.unshift(trade);
        list.length = Math.min(list.length, ROWS);
        history.set(trade.symbol, list);
        if (trade.symbol === symbol) fresh++;
      }
      if (fresh) render(Math.min(fresh, ROWS));
    },
    show(next) {
      symbol = next;
      render();
    },
  };
}
