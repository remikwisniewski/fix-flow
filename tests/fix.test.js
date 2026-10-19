import { describe, expect, it } from "vitest";
import {
  SOH,
  checksum,
  decode,
  encode,
  formatPrice,
  fromDisplay,
  parse,
  parsePrice,
  toDisplay,
  utcTimestamp,
} from "../src/engine/fix.js";
import { describeField, msgTypeName } from "../src/engine/dictionary.js";

// The Logon example from the FIX Wikipedia article: BodyLength 65, CheckSum 062.
const REFERENCE = "8=FIX.4.2|9=65|35=A|49=SERVER|56=CLIENT|34=177|52=20090107-18:15:16|98=0|108=30|10=062|";

describe("encode", () => {
  it("reproduces a published reference message byte for byte", () => {
    const raw = encode(
      [
        [35, "A"],
        [49, "SERVER"],
        [56, "CLIENT"],
        [34, "177"],
        [52, "20090107-18:15:16"],
        [98, "0"],
        [108, "30"],
      ],
      "FIX.4.2"
    );
    expect(toDisplay(raw)).toBe(REFERENCE);
  });

  it("defaults to FIX.4.4", () => {
    expect(encode([[35, "0"]]).startsWith(`8=FIX.4.4${SOH}`)).toBe(true);
  });

  it("requires MsgType to come first", () => {
    expect(() => encode([[49, "X"]])).toThrow("MsgType (35)");
  });

  it("refuses values that would break framing", () => {
    expect(() =>
      encode([
        [35, "D"],
        [58, `bad${SOH}value`],
      ])
    ).toThrow("SOH");
  });

  it("counts BodyLength in bytes, not characters", () => {
    const raw = encode([
      [35, "3"],
      [58, "café"],
    ]);
    expect(decode(raw).ok).toBe(true);
    expect(parse(raw).get(9)).toBe(String("35=3|58=café|".length + 1)); // é is two bytes
  });
});

describe("decode", () => {
  it("accepts the reference message", () => {
    const result = decode(fromDisplay(REFERENCE));
    expect(result.ok).toBe(true);
    expect(result.message.type).toBe("A");
    expect(result.message.get(108)).toBe("30");
  });

  it("round-trips anything encode produces", () => {
    const raw = encode([
      [35, "D"],
      [11, "ORD-1"],
      [55, "AAPL"],
      [54, "1"],
      [38, "100"],
      [40, "2"],
      [44, "187.24"],
    ]);
    const result = decode(raw);
    expect(result.ok).toBe(true);
    expect(result.message.fields.slice(2, -1)).toEqual([
      [35, "D"],
      [11, "ORD-1"],
      [55, "AAPL"],
      [54, "1"],
      [38, "100"],
      [40, "2"],
      [44, "187.24"],
    ]);
  });

  it.each([
    ["a wrong checksum", REFERENCE.replace("10=062", "10=063"), "CheckSum is 063 but should be 062"],
    ["a wrong body length", REFERENCE.replace("9=65", "9=64"), "BodyLength is 64 but the body is 65 bytes"],
    ["a tampered body", REFERENCE.replace("108=30", "108=31"), "CheckSum is 062 but should be 063"],
    ["a missing trailing SOH", REFERENCE.slice(0, -1), "must end with a SOH"],
    ["BeginString out of place", REFERENCE.replace("8=FIX.4.2|9=65|", "9=65|8=FIX.4.2|"), "BeginString (8)"],
    ["BodyLength out of place", REFERENCE.replace("9=65|35=A|", "35=A|9=65|"), "BodyLength (9)"],
    ["MsgType out of place", REFERENCE.replace("35=A|49=SERVER|", "49=SERVER|35=A|"), "MsgType (35)"],
    ["CheckSum not last", REFERENCE.replace("10=062|", "10=062|58=x|"), "CheckSum (10)"],
    ["a non-numeric tag", REFERENCE.replace("98=0", "x=0"), "Malformed tag"],
  ])("rejects %s", (_, display, error) => {
    const result = decode(fromDisplay(display));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain(error);
  });
});

describe("parse", () => {
  it("keeps every field in order and returns the first value for get()", () => {
    const message = parse(fromDisplay("8=FIX.4.4|35=D|58=one|58=two|"));
    expect(message.fields).toHaveLength(4);
    expect(message.get(58)).toBe("one");
    expect(message.get(999)).toBeUndefined();
  });

  it("tolerates a field without '='", () => {
    expect(parse(fromDisplay("35=0|garbage|")).fields[1]).toEqual([NaN, ""]);
  });
});

describe("checksum", () => {
  it("is the byte sum modulo 256, zero-padded to three digits", () => {
    expect(checksum("\x01")).toBe("001");
    expect(checksum("A".repeat(4))).toBe(String((65 * 4) % 256).padStart(3, "0"));
  });
});

describe("prices", () => {
  it.each([
    [18724, "187.24"],
    [18700, "187.00"],
    [5, "0.05"],
    [-150, "-1.50"],
  ])("formats %i cents as %s", (cents, text) => {
    expect(formatPrice(cents)).toBe(text);
  });

  it.each([
    ["187.24", 18724],
    ["187.2", 18720],
    ["187", 18700],
    ["0.01", 1],
  ])("parses %s as %i cents", (text, cents) => {
    expect(parsePrice(text)).toBe(cents);
  });

  it.each(["", "abc", "1.234", "-1.00", "1e3", undefined])("rejects %s", (text) => {
    expect(parsePrice(text)).toBeNull();
  });
});

describe("utcTimestamp", () => {
  it("formats as YYYYMMDD-HH:MM:SS.sss in UTC", () => {
    expect(utcTimestamp(Date.UTC(2026, 9, 19, 16, 51, 30, 969))).toBe("20261019-16:51:30.969");
  });
});

describe("dictionary", () => {
  it("names tags and decodes enumerated values", () => {
    expect(describeField(54, "1")).toEqual({ name: "Side", meaning: "Buy" });
    expect(describeField(44, "187.24")).toEqual({ name: "Price", meaning: null });
    expect(describeField(9999, "x")).toEqual({ name: "Tag 9999", meaning: null });
  });

  it("names message types", () => {
    expect(msgTypeName("8")).toBe("ExecutionReport");
    expect(msgTypeName("Z")).toBe("Unknown (Z)");
  });
});
