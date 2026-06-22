/**
 * Synthetic question bank — the input both decrypt paths consume.
 *
 * Mirrors Matiks' real match-start payload and the native bench
 * (`matiks-engine/src/native/cpp/matiks_decrypt.cpp`): ~75 questions, each a small JSON
 * object, AES-256-CBC encrypted with PKCS7 padding under a known 32-byte key and a random
 * per-blob IV, serialized as the string `"<ivHex>:<ctHex>"`.
 *
 * Generating the bank at startup means Button A (pure-JS decrypt) has *real* work to do and
 * both paths decrypt byte-identical data, so the timing comparison is honest.
 */

import { aesCbcEncrypt, fromHex, toHex, utf8Encode } from './aes';

/** The decrypted shape — same fields the C++ core emits, and what `decryptQuestions` returns. */
export interface Question {
  id: string;
  expression: string;
  answer: number;
  preset: string;
  rating: number;
}

/** How many questions in a match-start bank. Matches the native bench. */
export const QUESTION_COUNT = 75;

/**
 * The demo key. 32 ASCII chars = 32 bytes = AES-256. In production this is delivered out of
 * band; here it is shared by both paths so they decrypt the same thing.
 */
export const DEMO_KEY_STRING = 'matiks-demo-key-0123456789abcdef'; // exactly 32 chars
export const DEMO_KEY: Uint8Array = utf8Encode(DEMO_KEY_STRING);

/** A small, deterministic PRNG so the IVs (and thus the bank) are reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the plaintext JSON for question `q` — same field layout/size as the native bench. */
export function makeQuestionJson(q: number): string {
  let expr = '';
  for (let k = 0; k < 60; k++) {
    expr += String((q * 7 + k) % 97) + (k % 3 ? ' + ' : ' x ');
  }
  const answer = (q * 131) % 1000;
  const rating = 800 + q;
  // JSON.stringify keeps it well-formed; the long `expression` makes each blob ~hundreds of bytes
  // so the full bank lands in the same ~tens-of-KB range as Matiks' real payload.
  return JSON.stringify({
    id: String(q),
    expression: expr.trim(),
    answer,
    preset: 'ADD_2,1',
    rating,
  });
}

export interface SyntheticBank {
  /** The `"<ivHex>:<ctHex>"` blobs — the wire form both paths decrypt. */
  blobs: string[];
  /** Total ciphertext bytes (for the on-screen "payload size" note). */
  totalCipherBytes: number;
}

/**
 * Generate the synthetic bank: build each question's JSON, encrypt it under DEMO_KEY with a
 * fresh random IV, and emit `"<ivHex>:<ctHex>"`. Runs once at startup.
 */
export function generateBank(count: number = QUESTION_COUNT, seed = 42): SyntheticBank {
  const rng = mulberry32(seed);
  const blobs: string[] = [];
  let totalCipherBytes = 0;

  for (let q = 0; q < count; q++) {
    const plaintext = utf8Encode(makeQuestionJson(q));
    const iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) iv[i] = (rng() * 256) & 0xff;
    const ct = aesCbcEncrypt(DEMO_KEY, iv, plaintext);
    totalCipherBytes += ct.length;
    blobs.push(`${toHex(iv)}:${toHex(ct)}`);
  }

  return { blobs, totalCipherBytes };
}

/** Split a `"<ivHex>:<ctHex>"` blob into its two byte arrays. Shared by the JS decrypt path. */
export function parseBlob(blob: string): { iv: Uint8Array; ct: Uint8Array } {
  const idx = blob.indexOf(':');
  if (idx < 0) throw new Error('malformed blob (no separator)');
  return {
    iv: fromHex(blob.slice(0, idx)),
    ct: fromHex(blob.slice(idx + 1)),
  };
}
