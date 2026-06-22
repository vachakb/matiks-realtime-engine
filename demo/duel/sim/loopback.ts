// Loopback — an in-memory client↔server link with optional one-way latency, used by the DEMO and
// tests to run the engine against a simulated server (no real backend or opponent) while still
// exercising prediction/reconciliation: the latency is exactly what prediction hides and
// reconciliation corrects. (Real duels stay online — this is a test harness, not offline play.)
//
// `clientTransport` is handed to the RealtimeEngine (the client). The server side uses
// `onClientFrame` / `sendToClient`. `schedule` is injectable so tests drive time deterministically.

import type { Transport } from '../core/transport';

type Sink = (bytes: Uint8Array) => void;

export interface LoopbackOptions {
  /** One-way latency applied to every message in each direction (ms). */
  latencyMs?: number;
  /** Deferred scheduler; defaults to setTimeout. Inject for deterministic tests. */
  schedule?: (fn: () => void, ms: number) => void;
}

export class Loopback {
  readonly clientTransport: Transport;
  private readonly latencyMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private clientOnMsg?: Sink;
  private clientOnOpen?: () => void;
  private clientOnClose?: () => void;
  private serverOnFrame?: Sink;
  private open = false;

  constructor(opts: LoopbackOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));

    // The Transport the engine talks to. Arrow methods capture `this`.
    this.clientTransport = {
      connect: () => {
        this.open = true;
        this.delay(() => this.clientOnOpen?.());
      },
      close: () => {
        this.open = false;
        this.clientOnClose?.();
      },
      send: (bytes: Uint8Array) => {
        const copy = bytes.slice();
        this.delay(() => this.serverOnFrame?.(copy));
      },
      onMessage: (cb: Sink) => { this.clientOnMsg = cb; },
      onOpen: (cb: () => void) => { this.clientOnOpen = cb; },
      onClose: (cb: () => void) => { this.clientOnClose = cb; },
      get isOpen(): boolean { return false; }, // replaced below
    } as Transport;
    // Bind isOpen to live state (object-literal getter can't see `this.open` mutations cleanly).
    Object.defineProperty(this.clientTransport, 'isOpen', { get: () => this.open });
  }

  /** Server registers to receive decoded-bytes frames the client sends. */
  onClientFrame(cb: Sink): void { this.serverOnFrame = cb; }

  /** Server pushes bytes to the client (snapshots, ping/pong) — subject to latency. */
  sendToClient(bytes: Uint8Array): void {
    const copy = bytes.slice();
    this.delay(() => this.clientOnMsg?.(copy));
  }

  private delay(fn: () => void): void {
    if (this.latencyMs > 0) this.schedule(fn, this.latencyMs);
    else fn();
  }
}
