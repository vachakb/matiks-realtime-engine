/**
 * Wire codecs. The engine is codec-agnostic: the transport ships bytes, the codec
 * (de)serializes frames. We provide two:
 *
 *   - JsonCodec   — the baseline (what Matiks ships today: JSON.stringify / JSON.parse).
 *   - MsgpackCodec — a dependency-free MessagePack encoder/decoder (binary).
 *
 * Why this matters (measured on Matiks' real frames): their game-state frames are
 * 100% JSON text and ~57% compressible; on Hermes, JSON.parse is a top JS-thread cost.
 * A binary codec cuts both bytes and decode CPU. The codec lives in the shared core, so
 * the *same* serialization runs on native (Nitro) and web (Worker) — the server is untouched.
 */

export interface Codec {
  readonly name: string;
  encode(value: unknown): Uint8Array;
  decode(bytes: Uint8Array): unknown;
}

const te = new TextEncoder();
const td = new TextDecoder();

export const JsonCodec: Codec = {
  name: 'json',
  encode: (v) => te.encode(JSON.stringify(v)),
  decode: (b) => JSON.parse(td.decode(b)),
};

/** Growable byte writer backed by a single ArrayBuffer + DataView. */
class Writer {
  #buf = new Uint8Array(64);
  #view = new DataView(this.#buf.buffer);
  #len = 0;
  #ensure(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let cap = this.#buf.length * 2;
    while (cap < this.#len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
    this.#view = new DataView(next.buffer);
  }
  u8(v: number): void { this.#ensure(1); this.#buf[this.#len++] = v; }
  u16(v: number): void { this.#ensure(2); this.#view.setUint16(this.#len, v); this.#len += 2; }
  u32(v: number): void { this.#ensure(4); this.#view.setUint32(this.#len, v); this.#len += 4; }
  i8(v: number): void { this.#ensure(1); this.#view.setInt8(this.#len, v); this.#len += 1; }
  i16(v: number): void { this.#ensure(2); this.#view.setInt16(this.#len, v); this.#len += 2; }
  i32(v: number): void { this.#ensure(4); this.#view.setInt32(this.#len, v); this.#len += 4; }
  f64(v: number): void { this.#ensure(8); this.#view.setFloat64(this.#len, v); this.#len += 8; }
  raw(b: Uint8Array): void { this.#ensure(b.length); this.#buf.set(b, this.#len); this.#len += b.length; }
  done(): Uint8Array { return this.#buf.slice(0, this.#len); }
}

function encInt(w: Writer, n: number): void {
  if (n >= 0) {
    if (n < 0x80) w.u8(n);                          // positive fixint
    else if (n <= 0xff) { w.u8(0xcc); w.u8(n); }    // uint8
    else if (n <= 0xffff) { w.u8(0xcd); w.u16(n); } // uint16
    else if (n <= 0xffffffff) { w.u8(0xce); w.u32(n); } // uint32
    else { w.u8(0xcb); w.f64(n); }                  // too large -> float64
  } else {
    if (n >= -32) w.u8(0xe0 | (n + 32));            // negative fixint
    else if (n >= -0x80) { w.u8(0xd0); w.i8(n); }   // int8
    else if (n >= -0x8000) { w.u8(0xd1); w.i16(n); }// int16
    else if (n >= -0x80000000) { w.u8(0xd2); w.i32(n); } // int32
    else { w.u8(0xcb); w.f64(n); }
  }
}

function encStr(w: Writer, s: string): void {
  const bytes = te.encode(s);
  const n = bytes.length;
  if (n < 0x20) w.u8(0xa0 | n);                     // fixstr
  else if (n <= 0xff) { w.u8(0xd9); w.u8(n); }      // str8
  else if (n <= 0xffff) { w.u8(0xda); w.u16(n); }   // str16
  else { w.u8(0xdb); w.u32(n); }                    // str32
  w.raw(bytes);
}

function encode(w: Writer, v: unknown): void {
  if (v === null || v === undefined) { w.u8(0xc0); return; }
  switch (typeof v) {
    case 'boolean': w.u8(v ? 0xc3 : 0xc2); return;
    case 'number':
      if (Number.isInteger(v)) encInt(w, v);
      else { w.u8(0xcb); w.f64(v); }
      return;
    case 'string': encStr(w, v); return;
    case 'object': break;
    default: throw new TypeError(`msgpack: unsupported type ${typeof v}`);
  }
  if (v instanceof Uint8Array) {                    // bin8/16/32
    const n = v.length;
    if (n <= 0xff) { w.u8(0xc4); w.u8(n); }
    else if (n <= 0xffff) { w.u8(0xc5); w.u16(n); }
    else { w.u8(0xc6); w.u32(n); }
    w.raw(v);
    return;
  }
  if (Array.isArray(v)) {
    const n = v.length;
    if (n < 0x10) w.u8(0x90 | n);
    else if (n <= 0xffff) { w.u8(0xdc); w.u16(n); }
    else { w.u8(0xdd); w.u32(n); }
    for (const item of v) encode(w, item);
    return;
  }
  // plain object -> map (string keys, skipping undefined values, matching JSON semantics)
  const entries = Object.entries(v as Record<string, unknown>).filter(([, val]) => val !== undefined);
  const n = entries.length;
  if (n < 0x10) w.u8(0x80 | n);
  else if (n <= 0xffff) { w.u8(0xde); w.u16(n); }
  else { w.u8(0xdf); w.u32(n); }
  for (const [k, val] of entries) { encStr(w, k); encode(w, val); }
}

/** Stateful reader. */
class Reader {
  #b: Uint8Array;
  #view: DataView;
  #pos = 0;
  constructor(b: Uint8Array) { this.#b = b; this.#view = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  #take(n: number): number { const p = this.#pos; this.#pos += n; return p; }
  u8(): number { return this.#b[this.#take(1)]!; }
  read(): unknown {
    const c = this.u8();
    if (c < 0x80) return c;                          // positive fixint
    if (c >= 0xe0) return c - 0x100;                 // negative fixint
    if ((c & 0xf0) === 0x80) return this.#map(c & 0x0f);
    if ((c & 0xf0) === 0x90) return this.#arr(c & 0x0f);
    if ((c & 0xe0) === 0xa0) return this.#str(c & 0x1f);
    switch (c) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xcc: return this.u8();
      case 0xcd: { const p = this.#take(2); return this.#view.getUint16(p); }
      case 0xce: { const p = this.#take(4); return this.#view.getUint32(p); }
      case 0xcb: { const p = this.#take(8); return this.#view.getFloat64(p); }
      case 0xd0: { const p = this.#take(1); return this.#view.getInt8(p); }
      case 0xd1: { const p = this.#take(2); return this.#view.getInt16(p); }
      case 0xd2: { const p = this.#take(4); return this.#view.getInt32(p); }
      case 0xd9: return this.#str(this.u8());
      case 0xda: { const p = this.#take(2); return this.#str(this.#view.getUint16(p)); }
      case 0xdb: { const p = this.#take(4); return this.#str(this.#view.getUint32(p)); }
      case 0xc4: return this.#bin(this.u8());
      case 0xc5: { const p = this.#take(2); return this.#bin(this.#view.getUint16(p)); }
      case 0xc6: { const p = this.#take(4); return this.#bin(this.#view.getUint32(p)); }
      case 0xdc: { const p = this.#take(2); return this.#arr(this.#view.getUint16(p)); }
      case 0xdd: { const p = this.#take(4); return this.#arr(this.#view.getUint32(p)); }
      case 0xde: { const p = this.#take(2); return this.#map(this.#view.getUint16(p)); }
      case 0xdf: { const p = this.#take(4); return this.#map(this.#view.getUint32(p)); }
      default: throw new RangeError(`msgpack: unknown prefix 0x${c.toString(16)}`);
    }
  }
  #str(n: number): string { const p = this.#take(n); return td.decode(this.#b.subarray(p, p + n)); }
  #bin(n: number): Uint8Array { const p = this.#take(n); return this.#b.slice(p, p + n); }
  #arr(n: number): unknown[] { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = this.read(); return out; }
  #map(n: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < n; i++) { const k = this.read() as string; out[k] = this.read(); }
    return out;
  }
}

export const MsgpackCodec: Codec = {
  name: 'msgpack',
  encode(value: unknown): Uint8Array { const w = new Writer(); encode(w, value); return w.done(); },
  decode(bytes: Uint8Array): unknown { return new Reader(bytes).read(); },
};
