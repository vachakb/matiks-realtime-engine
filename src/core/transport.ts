// Transport abstraction — the engine speaks only bytes; the carrier is pluggable (native Nitro
// socket, web Worker socket, or the in-memory MockTransport for tests).
export interface Transport {
  connect(): void;
  close(): void;
  send(bytes: Uint8Array): void;
  onMessage(cb: (bytes: Uint8Array) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  readonly isOpen: boolean;
}

/** In-memory transport for tests/benchmarks. Records sent bytes; lets you inject inbound. */
export class MockTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  #onMessage?: (b: Uint8Array) => void;
  #onOpen?: () => void;
  #onClose?: () => void;
  #open = false;

  connect(): void { this.#open = true; this.#onOpen?.(); }
  close(): void { this.#open = false; this.#onClose?.(); }
  send(bytes: Uint8Array): void {
    if (!this.#open) throw new Error('MockTransport: send() while closed');
    this.sent.push(bytes);
  }
  onMessage(cb: (b: Uint8Array) => void): void { this.#onMessage = cb; }
  onOpen(cb: () => void): void { this.#onOpen = cb; }
  onClose(cb: () => void): void { this.#onClose = cb; }
  get isOpen(): boolean { return this.#open; }

  /** Test helper — simulate a frame arriving from the server. */
  deliver(bytes: Uint8Array): void { this.#onMessage?.(bytes); }
}
