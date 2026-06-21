/**
 * Web transport — proxies the socket to a Web Worker (`socket.worker.ts`), keeping network I/O
 * off the main thread. The app owns Worker construction (bundler-specific) and passes it in:
 *
 *   new WorkerTransport(url, new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' }))
 */
import type { Transport } from '../core/transport.ts';

export class WorkerTransport implements Transport {
  readonly #worker: Worker;
  readonly #url: string;
  #open = false;
  #onMessage?: (b: Uint8Array) => void;
  #onOpen?: () => void;
  #onClose?: () => void;

  constructor(url: string, worker: Worker) {
    this.#url = url;
    this.#worker = worker;
    this.#worker.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { ev: string; bytes?: ArrayBuffer };
      if (m.ev === 'open') { this.#open = true; this.#onOpen?.(); }
      else if (m.ev === 'close') { this.#open = false; this.#onClose?.(); }
      else if (m.ev === 'message' && m.bytes) { this.#onMessage?.(new Uint8Array(m.bytes)); }
    };
  }

  connect(): void { this.#worker.postMessage({ cmd: 'connect', url: this.#url }); }
  close(): void { this.#worker.postMessage({ cmd: 'close' }); }
  send(bytes: Uint8Array): void {
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.#worker.postMessage({ cmd: 'send', bytes: ab }, [ab]);
  }
  onMessage(cb: (b: Uint8Array) => void): void { this.#onMessage = cb; }
  onOpen(cb: () => void): void { this.#onOpen = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  get isOpen(): boolean { return this.#open; }
}
