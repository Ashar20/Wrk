/** Just enough DER to read an Android key attestation. Not a general ASN.1 library. */

export interface Tlv {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  tag: number;
  value: Buffer;
}

export class DerError extends Error {}

/** Reads one TLV at [offset]; returns it with the offset of whatever follows. */
export function readTlv(buf: Buffer, offset = 0): { tlv: Tlv; next: number } {
  if (offset >= buf.length) throw new DerError("Unexpected end of data.");
  const first = buf[offset++];
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let tag = first & 0x1f;
  if (tag === 0x1f) {
    // High tag number: base-128, high bit means "more bytes follow". Attestation fields use these (e.g. 704).
    tag = 0;
    for (let i = 0; ; i++) {
      if (offset >= buf.length || i > 4) throw new DerError("Bad tag.");
      const b = buf[offset++];
      tag = (tag << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  if (offset >= buf.length) throw new DerError("Missing length.");
  let len = buf[offset++];
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || offset + n > buf.length) throw new DerError("Bad length.");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset++];
  }
  if (offset + len > buf.length) throw new DerError("Value runs past the end of the data.");
  return { tlv: { cls, constructed, tag, value: buf.subarray(offset, offset + len) }, next: offset + len };
}

/** All TLVs directly inside [buf]. */
export function children(buf: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let o = 0; o < buf.length; ) {
    const { tlv, next } = readTlv(buf, o);
    out.push(tlv);
    o = next;
  }
  return out;
}

export const UNIVERSAL = { BOOLEAN: 1, INTEGER: 2, OCTET_STRING: 4, NULL: 5, OID: 6, ENUMERATED: 10, SEQUENCE: 16, SET: 17 } as const;

/** A small non-negative INTEGER or ENUMERATED. */
export function toInt(t: Tlv): number {
  if (t.value.length === 0 || t.value.length > 6) throw new DerError("Integer out of range.");
  let n = 0;
  for (const b of t.value) n = n * 256 + b;
  return n;
}

export const toBool = (t: Tlv) => t.value.length === 1 && t.value[0] !== 0;
