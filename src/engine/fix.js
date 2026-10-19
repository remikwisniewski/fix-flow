// @ts-check
// FIX tag=value codec. Builds messages with a correct BodyLength (9) and CheckSum (10),
// and parses/validates incoming ones byte-for-byte, the way a real FIX engine would.

/** Field delimiter: ASCII Start Of Heading. */
export const SOH = "\x01";
export const BEGIN_STRING = "FIX.4.4";

/** @typedef {[number, string]} Field */

/**
 * @typedef {object} ParsedMessage
 * @property {Field[]} fields  Every field, in wire order.
 * @property {string} type     Tag 35.
 * @property {(tag: number) => string | undefined} get  First value for a tag.
 */

const encoder = new TextEncoder();
const NON_ASCII = /[\u0080-\uffff]/;

/** Byte length, since FIX counts bytes, not characters. */
const byteLength = (/** @type {string} */ text) =>
  NON_ASCII.test(text) ? encoder.encode(text).length : text.length;

/**
 * Sum of all bytes modulo 256, as three digits.
 *
 * @param {string} text Everything before "10=".
 * @returns {string}
 */
export function checksum(text) {
  let sum = 0;
  if (NON_ASCII.test(text)) {
    for (const byte of encoder.encode(text)) sum += byte;
  } else {
    // Fast path: in ASCII every character is exactly one byte.
    for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i);
  }
  return String(sum % 256).padStart(3, "0");
}

/**
 * Encodes a message. Pass every field from MsgType (35) onward; BeginString,
 * BodyLength and CheckSum are added here.
 *
 * @param {Field[]} body
 * @param {string} [beginString]
 * @returns {string} Raw message with SOH delimiters.
 */
export function encode(body, beginString = BEGIN_STRING) {
  if (body[0]?.[0] !== 35) throw new Error("MsgType (35) must be the first body field");

  for (const [tag, value] of body) {
    if (String(value).includes(SOH)) throw new Error(`Tag ${tag} value contains a SOH delimiter`);
  }

  const payload = body.map(([tag, value]) => `${tag}=${value}${SOH}`).join("");
  const head = `8=${beginString}${SOH}9=${byteLength(payload)}${SOH}`;
  return `${head}${payload}10=${checksum(head + payload)}${SOH}`;
}

/**
 * Splits a raw message into fields without validating it.
 *
 * @param {string} raw
 * @returns {ParsedMessage}
 */
export function parse(raw) {
  /** @type {Field[]} */
  const fields = [];
  for (const part of raw.split(SOH)) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    fields.push([Number(part.slice(0, eq)), eq === -1 ? "" : part.slice(eq + 1)]);
  }

  /** @type {Map<number, string>} */
  const first = new Map();
  for (const [tag, value] of fields) if (!first.has(tag)) first.set(tag, value);

  return { fields, type: first.get(35) ?? "", get: (tag) => first.get(tag) };
}

/**
 * Checks framing the way a FIX engine does before trusting a message:
 * field order, BodyLength, CheckSum, and well-formed tags.
 *
 * @param {string} raw
 * @returns {{ ok: true, message: ParsedMessage } | { ok: false, error: string, message: ParsedMessage }}
 */
export function decode(raw) {
  const message = parse(raw);
  const fail = (/** @type {string} */ error) => ({ ok: /** @type {const} */ (false), error, message });
  const { fields } = message;

  if (!raw.endsWith(SOH)) return fail("Message must end with a SOH delimiter");
  if (fields.some(([tag]) => !Number.isInteger(tag) || tag <= 0)) return fail("Malformed tag");
  if (fields[0]?.[0] !== 8) return fail("BeginString (8) must be the first field");
  if (fields[1]?.[0] !== 9) return fail("BodyLength (9) must be the second field");
  if (fields[2]?.[0] !== 35) return fail("MsgType (35) must be the third field");
  if (fields.at(-1)?.[0] !== 10) return fail("CheckSum (10) must be the last field");

  const checksumAt = raw.lastIndexOf(`${SOH}10=`) + 1;
  const bodyStart = raw.indexOf(SOH, raw.indexOf(`${SOH}9=`) + 1) + 1;
  const declaredLength = Number(fields[1][1]);
  const actualLength = byteLength(raw.slice(bodyStart, checksumAt));
  if (declaredLength !== actualLength) {
    return fail(`BodyLength is ${declaredLength} but the body is ${actualLength} bytes`);
  }

  const declared = /** @type {Field} */ (fields.at(-1))[1];
  const actual = checksum(raw.slice(0, checksumAt));
  if (declared !== actual) return fail(`CheckSum is ${declared} but should be ${actual}`);

  return { ok: true, message };
}

/** Shows a raw message with "|" in place of SOH, the usual way FIX is logged. */
export const toDisplay = (/** @type {string} */ raw) => raw.replaceAll(SOH, "|");

/** The inverse of toDisplay, handy for tests and pasted log lines. */
export const fromDisplay = (/** @type {string} */ text) => text.replaceAll("|", SOH);

// ---------- Prices and times ----------
// Prices travel as integer cents inside the engine, so matching never meets
// floating-point rounding. They only become decimals on the wire.

/**
 * @param {number} cents
 * @returns {string} e.g. 18724 → "187.24"
 */
export function formatPrice(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * @param {string | undefined} text e.g. "187.24", "187.2" or "187"
 * @returns {number | null} Integer cents, or null if it isn't a valid price.
 */
export function parsePrice(text) {
  if (text === undefined || !/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/**
 * FIX UTCTimestamp with milliseconds: YYYYMMDD-HH:MM:SS.sss
 *
 * @param {number} epochMs
 * @returns {string}
 */
export function utcTimestamp(epochMs) {
  const iso = new Date(epochMs).toISOString(); // 2026-10-19T16:51:30.969Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 23)}`;
}
