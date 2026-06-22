// Belt-and-suspenders polyfills so the vendored engine runs on any Hermes build. Modern Hermes
// (RN 0.72+) already has TextEncoder/TextDecoder and structuredClone; these only fill gaps.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g: any = globalThis as any;

if (typeof g.structuredClone !== 'function') {
  g.structuredClone = (x: unknown) => JSON.parse(JSON.stringify(x));
}

if (typeof g.TextEncoder === 'undefined') {
  g.TextEncoder = class {
    encode(str: string): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < str.length; i++) {
        let c = str.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
          // surrogate pair
          const c2 = str.charCodeAt(++i);
          c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return new Uint8Array(out);
    }
  };
}

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class {
    decode(bytes: Uint8Array): string {
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const b = bytes[i++];
        if (b < 0x80) out += String.fromCharCode(b);
        else if (b < 0xe0) out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
        else if (b < 0xf0)
          out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        else {
          const cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
          const c = cp - 0x10000;
          out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
        }
      }
      return out;
    }
  };
}

export {};
