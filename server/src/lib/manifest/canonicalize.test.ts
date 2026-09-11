import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize";

describe("canonicalize (RFC 8785 JCS)", () => {
  it("matches the RFC 8785 worked example", () => {
    const input = {
      "1": { f: { f: "hi", F: 5 }, "\n": 56.0 },
      "10": {},
      "": "empty",
      a: {},
      "111": [{ e: "yes", E: "no" }],
      A: {},
    };

    expect(canonicalize(input)).toBe(
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},' +
        '"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
    );
  });

  it("serializes numbers with ECMAScript semantics", () => {
    expect(canonicalize([333333333.33333329, 1e30, 4.5, 2e-3, 1e-27])).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27]",
    );
  });

  it("normalises negative zero to zero", () => {
    expect(canonicalize({ z: -0 })).toBe('{"z":0}');
  });

  it("sorts keys by UTF-16 code unit, not locale or insertion order", () => {
    expect(canonicalize({ b: 1, A: 2, a: 3, "0": 4, B: 5 })).toBe(
      '{"0":4,"A":2,"B":5,"a":3,"b":1}',
    );
  });

  it("sorts keys inside array elements too", () => {
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it("escapes control characters with JSON short forms", () => {
    expect(canonicalize({ s: "a\tb\nc\u0001d" })).toBe(
      '{"s":"a\\tb\\nc\\u0001d"}',
    );
  });

  it("preserves non-ASCII characters literally rather than escaping them", () => {
    expect(canonicalize({ s: "€ü" })).toBe('{"s":"€ü"}');
  });

  it("is insensitive to key insertion order", () => {
    const a = { x: 1, y: { p: 1, q: 2 } };
    const b = { y: { q: 2, p: 1 }, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("rejects non-finite numbers rather than emitting null", () => {
    expect(() => canonicalize({ n: NaN })).toThrow(/finite/i);
    expect(() => canonicalize({ n: Infinity })).toThrow(/finite/i);
  });

  it("rejects undefined values rather than silently dropping the key", () => {
    // These guards exist for values arriving from JSON.parse and untyped
    // sources, so the tests must reach past the compile-time types.
    expect(() => canonicalize({ a: undefined } as never)).toThrow(/undefined/i);
  });

  it("rejects values JSON cannot represent deterministically", () => {
    expect(() => canonicalize({ f: () => 1 } as never)).toThrow();
    expect(() => canonicalize({ b: BigInt(1) } as never)).toThrow();
  });
});
