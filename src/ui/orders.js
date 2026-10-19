// @ts-check
// The client's view of its orders, rebuilt purely from the ExecutionReports it
// receives. This is how a real trading front end works: the exchange is the source of
// truth, and the blotter only ever reflects what came back over FIX.

import { FIX_TO_SIDE } from "../engine/session.js";

/** @typedef {import("../engine/fix.js").ParsedMessage} ParsedMessage */

/**
 * @typedef {object} ClientOrder
 * @property {string} orderId
 * @property {string} clOrdId
 * @property {string} symbol
 * @property {"buy" | "sell"} side
 * @property {"limit" | "market"} type
 * @property {string | null} price  As sent on the wire, e.g. "187.24".
 * @property {number} qty
 * @property {number} cumQty
 * @property {number} leavesQty
 * @property {string} avgPx
 * @property {string} status       OrdStatus (39).
 * @property {string | null} text  Reject or cancel reason.
 * @property {{ qty: number, price: string }[]} fills
 */

export const STATUS_LABELS = /** @type {Record<string, string>} */ ({
  0: "New",
  1: "Partial",
  2: "Filled",
  4: "Canceled",
  8: "Rejected",
});

/** @param {ClientOrder} order */
export const isOpen = (order) => order.status === "0" || order.status === "1";

/**
 * Applies one ExecutionReport to the order map and returns the updated order.
 *
 * @param {Map<string, ClientOrder>} orders Keyed by OrderID (37).
 * @param {ParsedMessage} report
 * @returns {ClientOrder}
 */
export function applyExecutionReport(orders, report) {
  if (report.type !== "8") throw new Error(`Expected an ExecutionReport, got MsgType ${report.type}`);

  const get = (/** @type {number} */ tag) => report.get(tag) ?? "";
  const orderId = get(37);
  let order = orders.get(orderId);

  if (!order) {
    order = {
      orderId,
      clOrdId: get(11),
      symbol: get(55),
      side: FIX_TO_SIDE[get(54)] ?? "buy",
      type: get(40) === "1" ? "market" : "limit",
      price: report.get(44) ?? null,
      qty: Number(get(38)),
      cumQty: 0,
      leavesQty: 0,
      avgPx: "0",
      status: "0",
      text: null,
      fills: [],
    };
    orders.set(orderId, order);
  }

  order.clOrdId = get(11) || order.clOrdId;
  order.cumQty = Number(get(14));
  order.leavesQty = Number(get(151));
  order.avgPx = get(6) || order.avgPx;
  order.status = get(39);
  if (report.get(58)) order.text = get(58);
  if (get(150) === "F") order.fills.push({ qty: Number(get(32)), price: get(31) });

  return order;
}
