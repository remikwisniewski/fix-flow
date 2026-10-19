// Order ticket. As you type, it shows the exact NewOrderSingle that will go on the
// wire, with BodyLength and CheckSum recomputed live.

import { formatPrice, parsePrice } from "../engine/fix.js";
import { FixClient } from "../engine/session.js";
import { formatQty, highlightRaw } from "./format.js";

export function createTicket({ form, wireEl, wireSizeEl, client, onSubmit }) {
  const submitBtn = form.querySelector("[data-submit]");
  const priceInput = form.elements.price;
  const qtyInput = form.elements.qty;
  let symbol = "AAPL";
  let enabled = false;
  let nextId = 1;

  /** Reads the form into an order request, or explains what's wrong. */
  function read() {
    const side = form.elements.side.value;
    const type = form.elements.type.value;
    const price = type === "limit" ? parsePrice(priceInput.value.trim()) : null;
    const qtyText = qtyInput.value.trim().replaceAll(",", "");
    const qty = /^\d+$/.test(qtyText) ? Number(qtyText) : NaN;
    const errors = {
      price: type === "limit" && (price === null || price <= 0),
      qty: !Number.isInteger(qty) || qty <= 0,
    };
    const request = {
      clOrdId: `YOU-${nextId}`,
      symbol,
      side,
      type,
      price,
      qty,
      tif: form.elements.ioc.checked ? "ioc" : "day",
    };
    return { request, errors, valid: !errors.price && !errors.qty };
  }

  function update() {
    const { request, errors, valid } = read();
    priceInput.disabled = request.type === "market";
    priceInput.setAttribute("aria-invalid", String(errors.price));
    qtyInput.setAttribute("aria-invalid", String(errors.qty));

    const verb = request.side === "buy" ? "Buy" : "Sell";
    const qty = Number.isInteger(request.qty) ? formatQty(request.qty) : "—";
    const at =
      request.type === "market" ? "at market" : request.price ? `@ ${formatPrice(request.price)}` : "";
    submitBtn.textContent = `${verb} ${qty} ${symbol} ${at}`.trim();
    submitBtn.dataset.side = request.side;
    submitBtn.disabled = !enabled || !valid;

    if (valid) {
      // Preview with a throwaway client so the real sequence number isn't consumed.
      const preview = Object.assign(
        new FixClient({ senderCompId: client.senderCompId, targetCompId: client.targetCompId }),
        {
          seq: client.seq,
        }
      );
      const raw = preview.newOrder(request);
      wireEl.innerHTML = highlightRaw(raw);
      wireSizeEl.textContent = `${new TextEncoder().encode(raw).length} bytes`;
    } else {
      wireEl.textContent = errors.price
        ? "Enter a price with up to 2 decimals."
        : "Enter a whole-number quantity.";
      wireSizeEl.textContent = "";
    }
  }

  form.addEventListener("input", update);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const { request, valid } = read();
    if (!valid || !enabled) return;
    nextId++;
    onSubmit(request);
    update();
  });

  return {
    setSymbol(next, lastPrice) {
      symbol = next;
      if (typeof lastPrice === "number") priceInput.value = formatPrice(lastPrice);
      update();
    },
    setPrice(cents) {
      form.elements.type.value = "limit";
      priceInput.value = formatPrice(cents);
      update();
      priceInput.focus();
    },
    setEnabled(next) {
      enabled = next;
      update();
    },
    refresh: update,
  };
}
