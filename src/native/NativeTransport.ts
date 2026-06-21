/**
 * Native transport — wraps the Nitro Hybrid Object so the SAME RealtimeEngine runs on
 * iOS/Android with the socket living on a dedicated native thread. ArrayBuffer <-> Uint8Array
 * conversions are the only glue; payloads cross JSI zero-copy.
 */
import { NitroModules } from 'react-native-nitro-modules';
import type { Transport } from '../core/transport.ts';
import type { MatiksRealtime } from './MatiksRealtime.nitro.ts';

const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export class NativeTransport implements Transport {
  readonly #m = NitroModules.createHybridObject<MatiksRealtime>('MatiksRealtime');
  readonly #url: string;
  constructor(url: string) { this.#url = url; }

  connect(): void { this.#m.connect(this.#url); }
  close(): void { this.#m.close(); }
  send(bytes: Uint8Array): void { this.#m.send(toArrayBuffer(bytes)); }
  onMessage(cb: (b: Uint8Array) => void): void { this.#m.onMessage = (ab) => cb(new Uint8Array(ab)); }
  onOpen(cb: () => void): void { this.#m.onOpen = cb; }
  onClose(cb: () => void): void { this.#m.onClose = cb; }
  get isOpen(): boolean { return this.#m.isOpen; }
}
