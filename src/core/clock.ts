/**
 * Monotonic, server-aligned clock.
 *
 * Matiks stamps answers with `getCurrentTime() = Date.now() + serverOffset` (confirmed in the
 * web bundle) — so client↔server skew is already corrected, but the base is still `Date.now()`,
 * a WALL clock. Wall clocks aren't monotonic: an NTP step or a post-sleep resync moves them, so
 * intra-duel elapsed time can still go backwards. That's a latent correctness risk in a *timed*
 * duel (a class of bug, not an observed failure — but one a server can't detect after the fact).
 * This anchors the same server offset to a **monotonic** local clock (`performance.now()`) over
 * the existing PING_PONG channel, so elapsed time can never go backwards.
 *
 * NTP sample math (t1=client send, t2=server recv, t3=server send, t4=client recv):
 *   rtt    = (t4 - t1) - (t3 - t2)
 *   offset = ((t2 - t1) + (t3 - t4)) / 2
 * We keep the offset from the lowest-RTT sample (least network distortion) — the standard
 * NTP heuristic.
 */
import type { PingSample } from './types.ts';

export class ClockSync {
  #offset = 0;
  #bestRtt = Infinity;
  #recentOffsets: number[] = [];
  #monotonic: () => number;

  constructor(monotonic: () => number = () => performance.now()) {
    this.#monotonic = monotonic;
  }

  addSample(s: PingSample): void {
    const rtt = (s.t4 - s.t1) - (s.t3 - s.t2);
    const offset = ((s.t2 - s.t1) + (s.t3 - s.t4)) / 2;
    // Negative RTT means a bogus/clock-warped sample — ignore it.
    if (rtt >= 0 && rtt < this.#bestRtt) {
      this.#bestRtt = rtt;
      this.#offset = offset;
    }
    this.#recentOffsets.push(offset);
    if (this.#recentOffsets.length > 64) this.#recentOffsets.shift();
  }

  /** Estimated offset between server clock and local monotonic clock (ms). */
  get offsetMs(): number { return this.#offset; }

  /** Best (lowest) observed round-trip time (ms). */
  get rttMs(): number { return this.#bestRtt === Infinity ? 0 : this.#bestRtt; }

  /** Standard deviation of recent offset estimates — a proxy for clock jitter. */
  get jitterMs(): number {
    const n = this.#recentOffsets.length;
    if (n < 2) return 0;
    const mean = this.#recentOffsets.reduce((a, b) => a + b, 0) / n;
    const variance = this.#recentOffsets.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return Math.sqrt(variance);
  }

  /** Server-aligned time (ms), monotonic — safe to subtract for elapsed/answer timing. */
  serverNow(): number { return this.#monotonic() + this.#offset; }
}
