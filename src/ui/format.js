// @ts-check
// Display formatting shared by the UI panels. Pure, so it's unit tested.

import { msgTypeName } from "../engine/dictionary.js";
import { formatPrice } from "../engine/fix.js";

/** @typedef {import("../engine/fix.js").ParsedMessage} ParsedMessage */

const qtyFormat = new Intl.NumberFormat("en-US");

/** @param {number} qty */
export const formatQty = (qty) => qtyFormat.format(qty);

/**
 * HH:MM:SS in UTC, matching FIX timestamps.
 *
 * @param {number} epochMs
 */
export const formatClock = (epochMs) => new Date(epochMs).toISOString().slice(11, 19);

/**
 * Change from a reference price, for the symbol tabs.
 *
 * @param {number} last
 * @param {number} ref
 * @returns {{ text: string, direction: "up" | "down" | "flat" }}
 */
export function formatChange(last, ref) {
  const pct = ((last - ref) / ref) * 100;
  const rounded = Math.round(pct * 100) / 100;
  if (rounded === 0) return { text: "0.00%", direction: "flat" };
  return { text: `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}%`, direction: rounded > 0 ? "up" : "down" };
}

/** @param {number | null} cents */
export const priceOrDash = (cents) => (cents === null ? "—" : formatPrice(cents));

/**
 * One-line summary of a message for the inspector list.
 *
 * @param {ParsedMessage} message
 * @returns {string}
 */
export function summarize(message) {
  const get = (/** @type {number} */ tag) => message.get(tag) ?? "";
  const side = get(54) === "1" ? "Buy" : "Sell";
  const priceText = get(44) ? ` @ ${get(44)}` : get(40) === "1" ? " @ market" : "";

  switch (message.type) {
    case "A":
      return `Logon · HeartBtInt ${get(108)}s`;
    case "0":
      return get(112) ? `Heartbeat · TestReqID ${get(112)}` : "Heartbeat";
    case "5":
      return get(58) ? `Logout · ${get(58)}` : "Logout";
    case "3":
      return `Reject · ${get(58)}`;
    case "D":
      return `${side} ${formatQty(Number(get(38)))} ${get(55)}${priceText}${get(59) === "3" ? " IOC" : ""}`;
    case "F":
      return `Cancel ${get(41)}`;
    case "9":
      return `Cancel rejected · ${get(58)}`;
    case "8": {
      const exec = get(150);
      if (exec === "F")
        return `${get(39) === "2" ? "Filled" : "Partial fill"} ${formatQty(Number(get(32)))} @ ${get(31)}`;
      if (exec === "0") return `New · ${side} ${formatQty(Number(get(38)))} ${get(55)}${priceText}`;
      if (exec === "4") return get(58) ? `Canceled · ${get(58)}` : "Canceled";
      if (exec === "8") return `Rejected · ${get(58)}`;
      return msgTypeName(message.type);
    }
    default:
      return msgTypeName(message.type);
  }
}

/**
 * Which inspector filter a message belongs to.
 *
 * @param {string} type MsgType (35).
 * @returns {"session" | "orders" | "executions"}
 */
export function category(type) {
  if (type === "D" || type === "F") return "orders";
  if (type === "8" || type === "9") return "executions";
  return "session";
}

const HTML_ESCAPES = /** @type {Record<string, string>} */ ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/**
 * Escapes text for safe use in innerHTML.
 *
 * @param {unknown} value
 */
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** Framing fields, drawn quieter than the business fields. */
const FRAME_TAGS = new Set(["8", "9", "10"]);

/**
 * Raw FIX as HTML: tags, values and "|" delimiters in separate spans.
 *
 * @param {string} raw
 */
export function highlightRaw(raw) {
  return raw
    .split("\x01")
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      const tag = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? "" : part.slice(eq + 1);
      const tagClass = FRAME_TAGS.has(tag) ? "tag tag--frame" : "tag";
      return `<span class="${tagClass}">${escapeHtml(tag)}</span>=<span class="val">${escapeHtml(value)}</span><span class="soh">|</span>`;
    })
    .join("");
}
