/**
 * RFC 8785 (JSON Canonicalization Scheme) serialization.
 *
 * This module is imported by BOTH the capture client and the API route that
 * verifies what the client submitted. There is exactly one implementation on
 * purpose: if the two sides ever disagree about the bytes underlying a
 * manifest hash, no episode in the system reconciles.
 *
 * See docs/superpowers/specs/2026-08-23-contributor-pwa-design.md §4.1.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * JCS defers number formatting to ECMAScript's Number-to-String algorithm,
 * which is precisely what JSON.stringify already implements. The only
 * divergence is negative zero, which ES renders as "0" via String(-0) but
 * which we normalise explicitly so the intent is visible.
 */
function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `Cannot canonicalize non-finite number: ${String(value)}. ` +
        "JSON.stringify would silently emit null, which would make two " +
        "different manifests hash identically.",
    );
  }
  if (Object.is(value, -0)) return "0";
  return JSON.stringify(value);
}

/**
 * JSON.stringify already produces RFC 8259 escaping with the short forms
 * (\b \t \n \f \r \" \\) and \uXXXX for remaining control characters, and
 * leaves non-ASCII intact. That matches JCS.
 */
function serializeString(value: string): string {
  return JSON.stringify(value);
}

function canonicalizeValue(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serializeNumber(value);
    case "string":
      return serializeString(value);
    case "undefined":
      throw new TypeError(
        `Cannot canonicalize undefined at ${path}. JSON.stringify would drop ` +
          "the key entirely, so a manifest with the key and one without it " +
          "would hash the same.",
      );
    case "bigint":
      throw new TypeError(`Cannot canonicalize bigint at ${path}.`);
    case "function":
    case "symbol":
      throw new TypeError(`Cannot canonicalize ${typeof value} at ${path}.`);
  }

  if (Array.isArray(value)) {
    // Array order is significant and is preserved as-is.
    return `[${value.map((item, i) => canonicalizeValue(item, `${path}[${i}]`)).join(",")}]`;
  }

  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(
      `Cannot canonicalize non-plain object at ${path}. Convert it to a plain ` +
        "object first so its serialization is explicit rather than incidental.",
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);

  // JCS sorts by UTF-16 code unit. Array.prototype.sort's default comparator
  // compares strings exactly that way, but we state it explicitly rather than
  // relying on a default that reads as an oversight.
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const members = entries.map(
    ([key, v]) => `${serializeString(key)}:${canonicalizeValue(v, `${path}.${key}`)}`,
  );

  return `{${members.join(",")}}`;
}

/** Serialize a value to its RFC 8785 canonical JSON form. */
export function canonicalize(value: JsonValue): string {
  return canonicalizeValue(value, "$");
}

/** UTF-8 bytes of the canonical form — the exact preimage that gets hashed. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
