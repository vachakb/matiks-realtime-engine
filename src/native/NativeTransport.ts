import { NitroModules } from 'react-native-nitro-modules';
import type { Transport } from '../core/transport.ts';
import type { MatiksSocket } from './MatiksSocket.nitro.ts';

// Adapts the native WebSocket Hybrid Object to the engine's Transport: the socket lives on a
// native thread, payloads cross JSI zero-copy. Design-stage (the spec isn't built into a module yet).
const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

export class NativeTransport implements Transport {
  readonly #m = NitroModules.createHybridObject<MatiksSocket>('MatiksSocket');
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
