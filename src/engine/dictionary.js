// @ts-check
// The slice of the FIX 4.4 data dictionary this simulator speaks: tag names and the
// meaning of enumerated values, used by the inspector to decode raw messages.

/** @type {Record<number, string>} */
export const TAG_NAMES = {
  6: "AvgPx",
  8: "BeginString",
  9: "BodyLength",
  10: "CheckSum",
  11: "ClOrdID",
  14: "CumQty",
  17: "ExecID",
  31: "LastPx",
  32: "LastQty",
  34: "MsgSeqNum",
  35: "MsgType",
  37: "OrderID",
  38: "OrderQty",
  39: "OrdStatus",
  40: "OrdType",
  41: "OrigClOrdID",
  44: "Price",
  45: "RefSeqNum",
  49: "SenderCompID",
  52: "SendingTime",
  54: "Side",
  55: "Symbol",
  56: "TargetCompID",
  58: "Text",
  59: "TimeInForce",
  60: "TransactTime",
  98: "EncryptMethod",
  102: "CxlRejReason",
  108: "HeartBtInt",
  112: "TestReqID",
  150: "ExecType",
  151: "LeavesQty",
  371: "RefTagID",
  372: "RefMsgType",
  373: "SessionRejectReason",
  434: "CxlRejResponseTo",
};

/** Message types, by tag 35 value. */
export const MSG_TYPES = /** @type {const} */ ({
  HEARTBEAT: "0",
  TEST_REQUEST: "1",
  REJECT: "3",
  LOGOUT: "5",
  EXECUTION_REPORT: "8",
  ORDER_CANCEL_REJECT: "9",
  LOGON: "A",
  NEW_ORDER_SINGLE: "D",
  ORDER_CANCEL_REQUEST: "F",
});

/** @type {Record<number, Record<string, string>>} */
export const ENUMS = {
  35: {
    0: "Heartbeat",
    1: "TestRequest",
    3: "Reject",
    5: "Logout",
    8: "ExecutionReport",
    9: "OrderCancelReject",
    A: "Logon",
    D: "NewOrderSingle",
    F: "OrderCancelRequest",
  },
  39: { 0: "New", 1: "Partially filled", 2: "Filled", 4: "Canceled", 8: "Rejected" },
  40: { 1: "Market", 2: "Limit" },
  54: { 1: "Buy", 2: "Sell" },
  59: { 0: "Day", 3: "Immediate or cancel" },
  98: { 0: "None" },
  102: { 0: "Too late to cancel", 1: "Unknown order" },
  150: { 0: "New", 4: "Canceled", 8: "Rejected", F: "Trade" },
  373: {
    0: "Invalid tag number",
    1: "Required tag missing",
    5: "Value is incorrect",
    6: "Incorrect data format",
    9: "CompID problem",
    11: "Invalid MsgType",
  },
  434: { 1: "Order cancel request" },
};

/**
 * Human-readable name and value meaning for one field.
 *
 * @param {number} tag
 * @param {string} value
 * @returns {{ name: string, meaning: string | null }}
 */
export function describeField(tag, value) {
  return {
    name: TAG_NAMES[tag] ?? `Tag ${tag}`,
    meaning: ENUMS[tag]?.[value] ?? null,
  };
}

/**
 * @param {string} type Tag 35 value.
 * @returns {string}
 */
export function msgTypeName(type) {
  return ENUMS[35][type] ?? `Unknown (${type})`;
}
