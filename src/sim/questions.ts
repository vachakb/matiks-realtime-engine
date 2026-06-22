// Deterministic arithmetic duel questions WITH answers, generated from a seed.
//
// Why seeded: in production Matiks ships the (encrypted) bank and the client decrypts it, so
// the client knows the correct answers locally — which is exactly why optimistic prediction is
// near-perfect (reports/duel.ts). We model that here by generating the SAME bank on both the
// client (to render + predict) and the authoritative server (its answer key to score against),
// from a gameId-derived seed — no answers travel on the wire, and the server never trusts the
// client's claim of correctness.

export interface DuelQuestion {
  questionId: string;
  prompt: string;
  answer: number;
}

/** mulberry32 — tiny deterministic PRNG (no Math.random, so client & server agree exactly). */
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

function seedFrom(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const OPS = ['+', '-', '×'] as const;

/** Generate `n` deterministic questions for `gameId`. Client and server call this identically. */
export function makeQuestions(gameId: string, n: number): DuelQuestion[] {
  const rnd = mulberry32(seedFrom(gameId));
  const out: DuelQuestion[] = [];
  for (let i = 0; i < n; i++) {
    const op = OPS[Math.floor(rnd() * OPS.length)];
    let a: number, b: number, answer: number;
    if (op === '×') {
      a = 2 + Math.floor(rnd() * 11); // 2..12
      b = 2 + Math.floor(rnd() * 11);
      answer = a * b;
    } else if (op === '-') {
      a = 10 + Math.floor(rnd() * 90); // ensure non-negative
      b = 1 + Math.floor(rnd() * a);
      answer = a - b;
    } else {
      a = 5 + Math.floor(rnd() * 95);
      b = 5 + Math.floor(rnd() * 95);
      answer = a + b;
    }
    out.push({ questionId: `${gameId}_${i}`, prompt: `${a} ${op} ${b}`, answer });
  }
  return out;
}
