// "Your orders": one row per order, built only from ExecutionReports. Fill progress
// animates from where it was to where it is now.

import { gsap } from "gsap";
import { escapeHtml, formatQty } from "./format.js";
import { STATUS_LABELS, isOpen } from "./orders.js";

export function createBlotter({ listEl, countEl, onCancel, reducedMotion }) {
  const shown = new Map(); // orderId → fill % last drawn

  listEl.addEventListener("click", (event) => {
    const button = event.target.closest("[data-cancel]");
    if (button) {
      button.disabled = true;
      onCancel(button.dataset.cancel);
    }
  });

  const row = (o) => {
    const pct = o.qty ? Math.round((o.cumQty / o.qty) * 100) : 0;
    const price = o.type === "market" ? "MKT" : o.price;
    const cancel = isOpen(o)
      ? `<button type="button" class="btn btn--sm order__cancel" data-cancel="${escapeHtml(o.orderId)}">Cancel</button>`
      : `<span class="pill" data-status="${o.status}">${STATUS_LABELS[o.status] ?? o.status}</span>`;
    const status = isOpen(o)
      ? `<span class="pill" data-status="${o.status}">${STATUS_LABELS[o.status]}</span>`
      : "";

    return `<div class="order" data-order="${escapeHtml(o.orderId)}">
        <span class="order__title"><span class="${o.side}">${o.side === "buy" ? "BUY" : "SELL"}</span>
          ${formatQty(o.qty)} ${escapeHtml(o.symbol)} @ ${escapeHtml(price)} ${status}</span>
        ${cancel}
        <div class="progress" role="progressbar" aria-label="Filled" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress__bar" data-pct="${pct}"></div>
        </div>
        <div class="order__meta">
          <span>${escapeHtml(o.clOrdId)} · ${escapeHtml(o.orderId)}</span>
          <span>${formatQty(o.cumQty)} filled${o.cumQty ? ` · avg ${escapeHtml(o.avgPx)}` : ""}</span>
        </div>
        ${o.text && o.status === "8" ? `<p class="order__text">${escapeHtml(o.text)}</p>` : ""}
      </div>`;
  };

  return {
    render(orders) {
      const list = [...orders.values()].reverse();
      if (!list.length) return;
      listEl.innerHTML = list.map(row).join("");
      countEl.textContent = `${list.filter(isOpen).length} open`;

      for (const bar of listEl.querySelectorAll(".progress__bar")) {
        const id = bar.closest("[data-order]").dataset.order;
        const pct = Number(bar.dataset.pct);
        const from = shown.get(id) ?? 0;
        shown.set(id, pct);
        if (reducedMotion || from === pct) {
          bar.style.width = `${pct}%`;
        } else {
          gsap.fromTo(bar, { width: `${from}%` }, { width: `${pct}%`, duration: 0.7, ease: "power3.out" });
        }
      }
    },
  };
}
