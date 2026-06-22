/**
 * The two decrypt paths the demo contrasts.
 *
 *  - `decryptOnJsThread`  — Button A: pure-JS AES-256-CBC, run SYNCHRONOUSLY on the JS thread.
 *                           This is the "current approach". While it runs, the JS thread is
 *                           pinned, so the requestAnimationFrame loop cannot fire → the spinner
 *                           FREEZES. (Why: rAF callbacks are scheduled on the JS thread; a busy
 *                           JS thread starves them — see 02-architecture-and-performance/
 *                           01-threading-model.md §1b and 01-core-concepts/
 *                           03-interactivity-and-gestures.md §6.)
 *
 *  - `decryptOffThread`   — Button B: hand the blobs to the MatiksRealtime Nitro module, which
 *                           does the AES on a dedicated NATIVE background thread and resolves a
 *                           Promise via the CallInvoker. The JS thread is free the whole time →
 *                           the spinner KEEPS SPINNING. (See report 13-native-decrypt-ondevice.md.)
 */

import { aesCbcDecrypt, utf8Decode } from './aes';
import { parseBlob, type Question } from './questions';

// ───────────────────────── Button A: on the JS thread ─────────────────────────

/**
 * Decrypt every blob synchronously, in pure JS, on the JS thread. Blocking by design — this is
 * the freeze we are demonstrating. Returns the decrypted questions plus a touched-bytes checksum
 * (a stand-in for the JSON.parse/state-hydration that also runs on the JS thread today).
 */
export function decryptOnJsThread(
  blobs: string[],
  key: Uint8Array,
): { questions: Question[]; checksum: number } {
  const questions: Question[] = [];
  let checksum = 0;
  for (const blob of blobs) {
    const { iv, ct } = parseBlob(blob);
    const plain = aesCbcDecrypt(key, iv, ct);
    for (let i = 0; i < plain.length; i++) checksum = (checksum + plain[i]) >>> 0;
    questions.push(JSON.parse(utf8Decode(plain)) as Question);
  }
  return { questions, checksum };
}

// ───────────────────────── Button B: off the JS thread (Nitro) ─────────────────────────

/**
 * Shape of the native module's decrypt entry point. Per report 13-native-decrypt-ondevice.md,
 * the ship target is the MatiksRealtime Nitro HybridObject exposing:
 *
 *     decryptQuestions(blobs: string[], key: string): Promise<Question[]>
 *
 * It runs the AES on a background thread and resolves on the JS thread via the CallInvoker.
 */
export interface MatiksRealtimeDecrypt {
  decryptQuestions(blobs: string[], key: string): Promise<Question[]>;
}

/**
 * Try to load the native module. We import it lazily/defensively so the demo still launches in
 * Expo Go or on a simulator where the native binary isn't present — in that case Button B falls
 * back to a yielding JS implementation and the UI clearly labels it as a SIMULATED off-thread run.
 */
// Metro provides a CommonJS-style `require` at runtime. Declare it locally so this file
// type-checks without depending on @types/node being present.
declare const require: (id: string) => any;

function loadNativeModule(): MatiksRealtimeDecrypt | null {
  try {
    const mod = require('react-native-matiks-realtime');
    const inst = mod?.MatiksRealtime ?? mod?.default ?? mod;
    if (inst && typeof inst.decryptQuestions === 'function') {
      return inst as MatiksRealtimeDecrypt;
    }
  } catch {
    // not installed / not built — fall through to the simulated path
  }
  return null;
}

export const nativeModule: MatiksRealtimeDecrypt | null = loadNativeModule();
export const hasNativeModule: boolean = nativeModule != null;

/**
 * Off-thread decrypt. If the native Nitro module is present we await it directly (real off-thread
 * work; JS thread truly free). Otherwise we run a *yielding* JS fallback that decrypts in small
 * chunks across animation frames — not genuinely off-thread, but it keeps the spinner alive so the
 * UI story still reads on a plain simulator. The result object flags which path actually ran.
 */
export async function decryptOffThread(
  blobs: string[],
  keyBytes: Uint8Array,
  keyString: string,
): Promise<{ questions: Question[]; usedNative: boolean }> {
  if (nativeModule) {
    const questions = await nativeModule.decryptQuestions(blobs, keyString);
    return { questions, usedNative: true };
  }

  // ── Simulated fallback (no native binary): decrypt in chunks, yielding to the event loop so
  //    the rAF spinner keeps running. This is NOT a true background thread — the native module is.
  const questions: Question[] = [];
  const CHUNK = 4;
  for (let start = 0; start < blobs.length; start += CHUNK) {
    const end = Math.min(start + CHUNK, blobs.length);
    for (let i = start; i < end; i++) {
      const { iv, ct } = parseBlob(blobs[i]);
      const plain = aesCbcDecrypt(keyBytes, iv, ct);
      questions.push(JSON.parse(utf8Decode(plain)) as Question);
    }
    // Yield: let the JS thread paint a frame and fire the rAF spinner between chunks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return { questions, usedNative: false };
}
