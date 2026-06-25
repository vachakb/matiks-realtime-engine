import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Off-thread question decryption for Matiks match-start.
 *
 * Each `blob` is `"ivHex:ctHex"` (AES-256-CBC, PKCS7).
 * `keyUtf8` is the 32-char UTF-8 string whose raw bytes are the AES-256 key.
 *
 * The whole decrypt loop runs on a background `std::thread` in C++ and the
 * Promise resolves back on the JS thread via Nitro's CallInvoker — so the
 * ~2.5 s Hermes JS-thread freeze becomes ~0 ms on the JS thread.
 *
 * Implemented in C++ on both platforms (`ios: 'c++'`, `android: 'c++'`) so the
 * SAME, FIPS-197-verified AES core compiles for macOS clang and the Android NDK.
 */
export interface MatiksRealtime
  extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /**
   * Decrypt `blobs` off the JS thread and resolve with the plaintext strings.
   *
   * @param blobs   array of `"ivHex:ctHex"` ciphertext blobs
   * @param keyUtf8 32-character key; its UTF-8 bytes are the AES-256 key
   * @returns plaintext strings, in the same order as `blobs`
   */
  decryptQuestions(blobs: string[], keyUtf8: string): Promise<string[]>

  /**
   * Identical decrypt, but marshals exactly ONE string across the JSI boundary in
   * each direction: `packedBlobs` is the `"ivHex:ctHex"` blobs joined by '\n', and the
   * result is the plaintexts joined by '\n'. Used to isolate the cost of per-element JSI
   * marshaling (75 strings) from the off-thread AES compute — if this is dramatically
   * faster than `decryptQuestions`, the bridge crossing was the bottleneck, not the AES.
   *
   * @param packedBlobs newline-joined `"ivHex:ctHex"` blobs (hex never contains '\n')
   * @param keyUtf8     32-character key; its UTF-8 bytes are the AES-256 key
   * @returns plaintexts joined by '\n', in the same order
   */
  decryptQuestionsPacked(packedBlobs: string, keyUtf8: string): Promise<string>
}
