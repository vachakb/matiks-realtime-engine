/**
 * Playable duel — the real-time engine running a full match on-device.
 *
 * Everything here is driven by the SAME engine + authoritative server that the Node tests use
 * (vendored into ./duel). The client (RealtimeEngine) talks to the authoritative MockMatiksServer
 * over an in-memory Loopback with simulated latency — so we can show, with no real backend:
 *   • Prediction — your answer scores INSTANTLY (before the server round-trip).
 *   • Reconciliation — the authoritative server confirms (or corrects) it.
 *   • Monotonic timing — the duel clock never jumps (no Date.now() fairness bug).
 *   • Integrity — tap "🤖 Bot" and the server detects superhuman cadence, flags it, and VOIDS
 *     the score; the client's optimistic score visibly rolls back. Server-authoritative.
 *   • JS thread stays free — the spinner keeps spinning the whole match (small messages
 *     off-threadable, unlike the big decrypt payload — see the Off-Thread Decrypt screen).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { RealtimeEngine } from './duel/core/engine';
import { Loopback } from './duel/sim/loopback';
import { MockMatiksServer } from './duel/sim/server';
import { makeQuestions, type DuelQuestion } from './duel/sim/questions';

const GAME_ID = 'demo-duel';
const N = 12;
const LATENCY_MS = 90; // one-way; this is the latency prediction hides + reconciliation covers

interface Choice {
  value: number;
  correct: boolean;
}

function choicesFor(q: DuelQuestion, idx: number): Choice[] {
  const wrongs = [q.answer + 1, q.answer - 1, q.answer + 2 + (idx % 3)];
  const all = [q.answer, ...wrongs];
  // deterministic shuffle by index so it's stable across re-renders
  const rot = idx % 4;
  const rotated = all.map((_, i) => all[(i + rot) % all.length]);
  return rotated.map((value) => ({ value, correct: value === q.answer }));
}

export default function DuelScreen() {
  const qs = useRef<DuelQuestion[]>(makeQuestions(GAME_ID, N)).current;
  const engineRef = useRef<RealtimeEngine | null>(null);
  const serverRef = useRef<MockMatiksServer | null>(null);
  const startRef = useRef<number>(Date.now());

  const [qi, setQi] = useState(0);
  const [score, setScore] = useState(0);
  const [opp, setOpp] = useState({ score: 0, index: 0 });
  const [flagged, setFlagged] = useState<{ flagged: boolean; reason?: string } | null>(null);
  const [pred, setPred] = useState({ submits: 0, reconciliations: 0, rollbacks: 0 });
  const [elapsed, setElapsed] = useState(0);
  const [angle, setAngle] = useState(0);
  const [feedback, setFeedback] = useState('Answer fast — your opponent is solving too.');
  const [gen, setGen] = useState(0); // bump to reset

  // ---- engine + authoritative server lifecycle (recreated on reset) ----
  useEffect(() => {
    const link = new Loopback({ latencyMs: LATENCY_MS });
    const now = () => Date.now();
    const server = new MockMatiksServer({
      link, gameId: GAME_ID, userId: 'me', questionCount: N, now,
      opponentIntervalMs: 1600, minHumanMs: 350, anomalyStreak: 3,
    });
    server.start();
    const engine = new RealtimeEngine({ transport: link.clientTransport, userId: 'me', monotonic: now });
    engine.onState((s) => {
      setScore(s.score);
      const o = engine.opponent;
      if (o) setOpp({ score: o.score, index: o.questionIndex });
      const ig = engine.integrity;
      if (ig?.flagged) setFlagged(ig);
      const m = engine.metrics.prediction;
      setPred({ submits: m.submits, reconciliations: m.reconciliations, rollbacks: m.rollbacks });
    });
    engine.connect();
    engine.joinGame(GAME_ID);
    engineRef.current = engine;
    serverRef.current = server;
    startRef.current = Date.now();

    const tick = setInterval(() => server.tick(), 250);
    return () => { clearInterval(tick); engine.close(); };
  }, [gen]);

  // ---- rAF spinner + monotonic timer (the "JS thread free?" readout) ----
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setAngle((a) => (a + 6) % 360);
      setElapsed(Date.now() - startRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [gen]);

  const done = qi >= N || flagged?.flagged;

  const answer = useCallback((c: Choice) => {
    const engine = engineRef.current;
    const q = qs[qi];
    if (!engine || !q || done) return;
    engine.submitAnswer({ questionId: q.questionId, submittedValue: c.value, correctValue: q.answer });
    setFeedback(c.correct ? '✓ correct — scored instantly (predicted), server confirming…' : '✗ wrong');
    setQi((i) => i + 1);
  }, [qi, qs, done]);

  const cheat = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    setFeedback('🤖 bot: auto-answering correctly at 40ms/question…');
    let k = qi;
    const end = Math.min(qi + 4, N);
    const fire = () => {
      const q = qs[k];
      if (!q || k >= end) return;
      engine.submitAnswer({ questionId: q.questionId, submittedValue: q.answer, correctValue: q.answer });
      k += 1;
      setQi(k);
      if (k < end) setTimeout(fire, 40); // 40ms gaps → superhuman → server flags it
    };
    fire();
  }, [qi, qs]);

  const reset = useCallback(() => {
    setQi(0); setScore(0); setOpp({ score: 0, index: 0 }); setFlagged(null);
    setPred({ submits: 0, reconciliations: 0, rollbacks: 0 }); setFeedback('New match — go!');
    setGen((g) => g + 1);
  }, []);

  const q = qs[Math.min(qi, N - 1)];
  const choices = choicesFor(q, qi);
  const leading = score > opp.score ? 'you' : score < opp.score ? 'opponent' : 'tied';

  return (
    <View style={styles.root}>
      {/* header */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>Duel</Text>
        <View style={styles.spinner}>
          <View style={[styles.spinnerArc, { transform: [{ rotate: `${angle}deg` }] }]} />
        </View>
        <Text style={styles.timer}>{(elapsed / 1000).toFixed(1)}s</Text>
      </View>
      <Text style={styles.sub}>engine · prediction + reconciliation + monotonic clock · {LATENCY_MS}ms link</Text>

      {/* scoreboard */}
      <View style={styles.board}>
        <View style={[styles.side, leading === 'you' && styles.lead]}>
          <Text style={styles.sideLabel}>You</Text>
          <Text style={styles.sideScore}>{score}</Text>
          <Text style={styles.sideMeta}>Q {Math.min(qi, N)}/{N}</Text>
        </View>
        <Text style={styles.vs}>vs</Text>
        <View style={[styles.side, leading === 'opponent' && styles.lead]}>
          <Text style={styles.sideLabel}>Opponent</Text>
          <Text style={styles.sideScore}>{opp.score}</Text>
          <Text style={styles.sideMeta}>Q {opp.index}/{N}</Text>
        </View>
      </View>

      {/* integrity banner */}
      {flagged?.flagged && (
        <View style={styles.flag}>
          <Text style={styles.flagTitle}>🚨 BOT DETECTED — DISQUALIFIED</Text>
          <Text style={styles.flagBody}>{flagged.reason}</Text>
          <Text style={styles.flagBody}>Server voided the score → your optimistic score rolled back to 0.</Text>
        </View>
      )}

      {/* question + choices */}
      {!done && (
        <>
          <Text style={styles.prompt}>{q.prompt}</Text>
          <View style={styles.choices}>
            {choices.map((c, i) => (
              <Pressable key={i} style={({ pressed }) => [styles.choice, pressed && styles.choicePressed]} onPress={() => answer(c)}>
                <Text style={styles.choiceText}>{c.value}</Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      {done && !flagged?.flagged && (
        <Text style={styles.finish}>Match over — you {score >= opp.score ? 'won' : 'lost'} {score}–{opp.score}</Text>
      )}

      <Text style={styles.feedback}>{feedback}</Text>

      {/* engine readout */}
      <Text style={styles.metrics}>
        predicted: {pred.submits} · reconciled: {pred.reconciliations} · rollbacks: {pred.rollbacks} · spinner smooth = JS thread free
      </Text>

      {/* controls */}
      <View style={styles.controls}>
        <Pressable style={[styles.btn, styles.cheatBtn]} onPress={cheat} disabled={!!done}>
          <Text style={styles.btnText}>🤖 Cheat (bot answers)</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.resetBtn]} onPress={reset}>
          <Text style={styles.btnText}>↺ New match</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020', padding: 20, paddingTop: 56 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  title: { color: '#f8fafc', fontSize: 30, fontWeight: '800', flex: 1 },
  spinner: { width: 28, height: 28, borderRadius: 14, borderWidth: 4, borderColor: '#1e293b', borderTopColor: '#38bdf8' },
  spinnerArc: { flex: 1 },
  timer: { color: '#38bdf8', fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  sub: { color: '#64748b', fontSize: 12, marginTop: 4 },

  board: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, gap: 10 },
  side: { flex: 1, backgroundColor: '#111827', borderRadius: 14, borderWidth: 2, borderColor: '#1e293b', padding: 14, alignItems: 'center' },
  lead: { borderColor: '#22c55e' },
  sideLabel: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
  sideScore: { color: '#f8fafc', fontSize: 40, fontWeight: '800' },
  sideMeta: { color: '#64748b', fontSize: 12 },
  vs: { color: '#475569', fontSize: 14, fontWeight: '700' },

  flag: { backgroundColor: '#7f1d1d', borderRadius: 12, padding: 14, marginTop: 18 },
  flagTitle: { color: '#fecaca', fontSize: 16, fontWeight: '800' },
  flagBody: { color: '#fca5a5', fontSize: 13, marginTop: 4 },

  prompt: { color: '#f8fafc', fontSize: 52, fontWeight: '800', textAlign: 'center', marginTop: 28 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 24, gap: 12 },
  choice: { width: '47%', backgroundColor: '#1d4ed8', borderRadius: 14, paddingVertical: 22, alignItems: 'center' },
  choicePressed: { opacity: 0.8 },
  choiceText: { color: '#fff', fontSize: 26, fontWeight: '800' },

  finish: { color: '#f8fafc', fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 28 },
  feedback: { color: '#cbd5e1', fontSize: 14, marginTop: 20, textAlign: 'center' },
  metrics: { color: '#64748b', fontSize: 12, marginTop: 10, textAlign: 'center' },

  controls: { flexDirection: 'row', gap: 12, marginTop: 'auto' },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  cheatBtn: { backgroundColor: '#b45309' },
  resetBtn: { backgroundColor: '#334155' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
