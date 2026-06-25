/**
 * Playable duel — Matiks' real mechanism, built to reproduce + fix the EXACT issue the on-device
 * A13 trace showed: a continuous ~60fps render loop that never idles (≈590 doFrames per 10s, every
 * bucket, even when nothing on screen changed). Typing was NOT the culprit there (47 input events
 * in 220s) — the perpetual per-frame render is. So the A/B isolates that:
 *
 *   NAIVE  : a JS-driven countdown ticked every frame via requestAnimationFrame + setState, in one
 *            big component → the WHOLE screen (timer, scoreboard, question panel, input) re-renders
 *            ~60×/sec continuously, pegging the JS thread. This is the live-app pattern.
 *   ENGINE : the countdown animates on the NATIVE driver (UI thread, zero JS per frame); the timer
 *            value, score and opponent are isolated slices; the question panel is memoized → the JS
 *            thread IDLES when nothing changes and only wakes on a real update.
 *
 * Mechanism (faithful to Matiks): timer-based (answer as many as you can before the clock; most
 * correct wins; no answers after time's up), and a TYPED auto-evaluating input (type a number, it
 * auto-submits the instant it equals the answer). Match end is authoritative via engine `phase`.
 *
 * The on-screen "question panel rendered N times" counter shows the win without a trace; "▶ Auto-
 * play" drives a reproducible answer stream for the Perfetto capture.
 */

import React, {
  memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { RealtimeEngine, type EngineSnapshot, type OpponentState } from './duel/core/engine';
import { select, type ExternalStore } from './duel/core/store';
import { Loopback } from './duel/sim/loopback';
import { MockMatiksServer } from './duel/sim/server';
import { makeQuestions, type DuelQuestion } from './duel/sim/questions';

const GAME_ID = 'demo-duel';
const POOL = 120;          // deep question pool — you won't exhaust it before the timer
const MATCH_MS = 30_000;   // the duel clock
const LATENCY_MS = 90;
const PANEL_CELLS = 120;   // an expensive panel, so an unnecessary re-render is measurable

const selScore = (s: EngineSnapshot): number => s.self.score;
const selOpponent = (s: EngineSnapshot): OpponentState | undefined => s.opponent;
const selIntegrity = (s: EngineSnapshot): EngineSnapshot['integrity'] => s.integrity;
const selTiming = (s: EngineSnapshot): EngineSnapshot['timing'] => s.timing;
const selPhase = (s: EngineSnapshot): EngineSnapshot['phase'] => s.phase;

function useSlice<T>(engine: RealtimeEngine, selector: (s: EngineSnapshot) => T): T {
  const store = useMemo(() => select(engine, selector), [engine, selector]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}

function makeKeystrokeStore() {
  let typed = '';
  const subs = new Set<() => void>();
  const notify = () => { for (const f of subs) f(); };
  const store: ExternalStore<string> & { set(s: string): void; clear(): void } = {
    subscribe(l) { subs.add(l); return () => subs.delete(l); },
    getSnapshot() { return typed; },
    set(s) { typed = s; notify(); },
    clear() { if (typed !== '') { typed = ''; notify(); } },
  };
  return store;
}

function buildSim() {
  const link = new Loopback({ latencyMs: LATENCY_MS });
  const now = () => Date.now();
  const server = new MockMatiksServer({
    link, gameId: GAME_ID, userId: 'me', questionCount: POOL, now,
    opponentIntervalMs: 1400, minHumanMs: 250, anomalyStreak: 4, durationMs: MATCH_MS,
  });
  const engine = new RealtimeEngine({ transport: link.clientTransport, userId: 'me', monotonic: now });
  return { engine, server };
}

/** Shared duel state/logic — identical for both modes so the A/B differs ONLY in rendering. */
function useDuel() {
  const qs = useMemo<DuelQuestion[]>(() => makeQuestions(GAME_ID, POOL), []);
  const sim = useMemo(buildSim, []);
  const keystroke = useMemo(makeKeystrokeStore, []);
  const panelRenders = useRef({ current: 0 }).current;
  const [qi, setQi] = useState(0);

  const qiRef = useRef(0); qiRef.current = qi;
  const answerRef = useRef(qs[0].answer); answerRef.current = qs[qi % POOL].answer;
  const overRef = useRef(false);

  useEffect(() => {
    const { engine, server } = sim;
    server.start();
    engine.connect();
    engine.joinGame(GAME_ID);
    const offPhase = engine.onPhase((p) => {
      overRef.current = p === 'ended';
      if (__DEV__) console.log(`[duel] phase=${p} → ${p === 'active' ? 'PAUSE' : 'RESUME'} non-essential UI-thread work (e.g. Clarity)`);
    });
    const tick = setInterval(() => server.tick(), 250);
    // Auto-eval, done imperatively (NOT in render) so a keystroke only advances on a correct answer.
    const offEval = keystroke.subscribe(() => {
      const t = keystroke.getSnapshot();
      if (t !== '' && Number(t) === answerRef.current && !overRef.current) {
        const q = qs[qiRef.current % POOL];
        engine.submitAnswer({ questionId: q.questionId, submittedValue: q.answer, correctValue: q.answer });
        keystroke.clear();
        setQi((i) => i + 1);
      }
    });
    return () => { offPhase(); offEval(); clearInterval(tick); engine.close(); };
  }, [sim, keystroke, qs]);

  const [autoplaying, setAutoplaying] = useState(false);
  const autoPlay = useCallback(() => {
    if (autoplaying) return;
    setAutoplaying(true);
    let active = true;
    const step = () => {
      if (!active || overRef.current) { setAutoplaying(false); return; }
      const ans = String(answerRef.current);
      const cur = keystroke.getSnapshot();
      keystroke.set(ans.slice(0, Math.min(ans.length, cur.length + 1))); // type one more digit
      setTimeout(step, 45);
    };
    step();
    setTimeout(() => { active = false; setAutoplaying(false); }, 12_000);
  }, [autoplaying, keystroke]);

  return { engine: sim.engine, qs, qi, keystroke, panelRenders, autoPlay, autoplaying };
}

// ============================ shared leaf components ============================

function QuestionPanelInner({ prompt, counter }: { prompt: string; counter: { current: number } }) {
  counter.current += 1;
  const cells = [];
  for (let i = 0; i < PANEL_CELLS; i++) {
    let v = i; for (let k = 0; k < 30; k++) v = (v * 31 + 7) % 9973;
    cells.push(<View key={i} style={[styles.cell, { opacity: 0.2 + (v % 60) / 100 }]} />);
  }
  return (
    <View style={styles.panel}>
      <Text style={styles.prompt}>{prompt}</Text>
      <View style={styles.cells}>{cells}</View>
    </View>
  );
}
const MemoQuestionPanel = memo(QuestionPanelInner);

function PanelStat({ counter, optimized }: { counter: { current: number }; optimized: boolean }) {
  // refreshes its own display ~2Hz so you can watch the count climb, without re-rendering siblings
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 500); return () => clearInterval(id); }, []);
  return (
    <View style={styles.statBox}>
      <Text style={styles.stat}>question panel rendered <Text style={styles.statNum}>{counter.current}</Text> times</Text>
      <Text style={styles.statSub}>{optimized ? 'rises only when the question changes (JS idles otherwise)' : 'rises ~60×/sec — whole screen re-renders every frame'}</Text>
    </View>
  );
}

// ============================ ENGINE mode ============================

const EngineTimer = memo(function EngineTimer({ engine }: { engine: RealtimeEngine }) {
  const timing = useSlice(engine, selTiming);
  const scaleX = useRef(new Animated.Value(1)).current;
  const [secs, setSecs] = useState<number | null>(null);
  useEffect(() => {
    if (!timing) return;
    const total = timing.endsAt - timing.startedAt;
    const remaining = Math.max(0, timing.endsAt - Date.now());
    scaleX.setValue(total > 0 ? remaining / total : 0);
    // NATIVE DRIVER: the bar depletes on the UI thread — zero JS per frame.
    Animated.timing(scaleX, { toValue: 0, duration: remaining, easing: Easing.linear, useNativeDriver: true }).start();
    const t = () => setSecs(Math.max(0, Math.ceil((timing.endsAt - Date.now()) / 1000)));
    t(); const id = setInterval(t, 250); return () => clearInterval(id); // seconds text at 4Hz, isolated
  }, [timing, scaleX]);
  return (
    <View style={styles.timerWrap}>
      <View style={styles.barTrack}><Animated.View style={[styles.barFill, { transform: [{ scaleX }] }]} /></View>
      <Text style={styles.timer}>{secs == null ? '—' : `${secs}s`}</Text>
    </View>
  );
});

const Scoreboard = memo(function Scoreboard({ engine }: { engine: RealtimeEngine }) {
  const score = useSlice(engine, selScore);
  const o = useSlice(engine, selOpponent)?.score ?? 0;
  return <Board score={score} opp={o} />;
});

const AnswerField = memo(function AnswerField({ store }: { store: ReturnType<typeof makeKeystrokeStore> }) {
  const typed = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return <Input typed={typed} onChange={store.set} />;
});

function EngineDuel({ duel }: { duel: ReturnType<typeof useDuel> }) {
  const { engine, qs, qi, keystroke, panelRenders } = duel;
  const phase = useSlice(engine, selPhase);
  const flagged = !!useSlice(engine, selIntegrity)?.flagged;
  const over = phase === 'ended';
  return (
    <>
      <Header title="Duel" sub="ENGINE · native-driver timer + slices · JS idles when static" timer={<EngineTimer engine={engine} />} />
      <Scoreboard engine={engine} />
      {flagged && <Flag engine={engine} />}
      <MemoQuestionPanel prompt={qs[qi % POOL].prompt} counter={panelRenders} />
      {over ? <FinalResult engine={engine} /> : <AnswerField store={keystroke} />}
      <PanelStat counter={panelRenders} optimized />
    </>
  );
}

// ============================ NAIVE mode ============================

function NaiveDuel({ duel }: { duel: ReturnType<typeof useDuel> }) {
  const { engine, qs, qi, keystroke, panelRenders } = duel;
  // The bug being reproduced: a per-frame rAF tick at the TOP re-renders the whole screen ~60×/s.
  const [, setFrame] = useState(0);
  useEffect(() => {
    let raf = 0;
    const loop = () => { setFrame((f) => f + 1); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const typed = useSyncExternalStore(keystroke.subscribe, keystroke.getSnapshot); // consumed at top
  const snap = engine.getSnapshot();           // read every frame
  const t = snap.timing;
  const remaining = t ? Math.max(0, t.endsAt - Date.now()) : 0;
  const frac = t && t.endsAt > t.startedAt ? remaining / (t.endsAt - t.startedAt) : 1;
  const secs = Math.ceil(remaining / 1000);
  const over = snap.phase === 'ended';
  const flagged = !!snap.integrity?.flagged;

  return (
    <>
      <Header
        title="Duel"
        sub="NAIVE · timer ticked in JS every frame · whole screen re-renders"
        timer={
          <View style={styles.timerWrap}>
            <View style={styles.barTrack}><View style={[styles.barFillNaive, { width: `${frac * 100}%` }]} /></View>
            <Text style={styles.timer}>{secs}s</Text>
          </View>
        }
      />
      <Board score={snap.self.score} opp={snap.opponent?.score ?? 0} />
      {flagged && <Flag engine={engine} />}
      {/* inline (not memoized) → re-renders every frame with the parent */}
      <QuestionPanelInner prompt={qs[qi % POOL].prompt} counter={panelRenders} />
      {over ? <FinalResult engine={engine} /> : <Input typed={typed} onChange={keystroke.set} />}
      <PanelStat counter={panelRenders} optimized={false} />
    </>
  );
}

// ============================ presentational (shared) ============================

function Header({ title, sub, timer }: { title: string; sub: string; timer: React.ReactNode }) {
  return (
    <>
      <View style={styles.headerRow}>
        <Text style={styles.h1}>{title}</Text>
        {timer}
      </View>
      <Text style={styles.sub}>{sub}</Text>
    </>
  );
}
function Board({ score, opp }: { score: number; opp: number }) {
  const leading = score > opp ? 'you' : score < opp ? 'opponent' : 'tied';
  return (
    <View style={styles.board}>
      <View style={[styles.side, leading === 'you' && styles.lead]}><Text style={styles.sideLabel}>You</Text><Text style={styles.sideScore}>{score}</Text></View>
      <Text style={styles.vs}>vs</Text>
      <View style={[styles.side, leading === 'opponent' && styles.lead]}><Text style={styles.sideLabel}>Opponent</Text><Text style={styles.sideScore}>{opp}</Text></View>
    </View>
  );
}
function Input({ typed, onChange }: { typed: string; onChange: (s: string) => void }) {
  return (
    <TextInput style={styles.input} value={typed} onChangeText={onChange} keyboardType="number-pad"
      placeholder="type the answer…" placeholderTextColor="#475569" />
  );
}
const Flag = memo(function Flag({ engine }: { engine: RealtimeEngine }) {
  const reason = useSlice(engine, selIntegrity)?.reason;
  return <View style={styles.flag}><Text style={styles.flagTitle}>🚨 BOT DETECTED — score voided</Text><Text style={styles.flagBody}>{reason}</Text></View>;
});
const FinalResult = memo(function FinalResult({ engine }: { engine: RealtimeEngine }) {
  const score = useSlice(engine, selScore);
  const o = useSlice(engine, selOpponent)?.score ?? 0;
  const v = score > o ? 'You won' : score < o ? 'You lost' : 'Tied';
  return <Text style={styles.finish}>Time! {v} {score}–{o}</Text>;
});

// ============================ screen + A/B toggle ============================

export default function DuelScreen() {
  const [mode, setMode] = useState<'engine' | 'naive'>('engine');
  return (
    <View style={styles.screen}>
      <View style={styles.segRow}>
        <Pressable onPress={() => setMode('naive')} style={[styles.seg, mode === 'naive' && styles.segOn]}><Text style={[styles.segTxt, mode === 'naive' && styles.segTxtOn]}>Naive</Text></Pressable>
        <Pressable onPress={() => setMode('engine')} style={[styles.seg, mode === 'engine' && styles.segOn]}><Text style={[styles.segTxt, mode === 'engine' && styles.segTxtOn]}>Engine</Text></Pressable>
      </View>
      <DuelBody key={mode} optimized={mode === 'engine'} />
    </View>
  );
}

function DuelBody({ optimized }: { optimized: boolean }) {
  const duel = useDuel();
  return (
    <View style={styles.root}>
      {optimized ? <EngineDuel duel={duel} /> : <NaiveDuel duel={duel} />}
      <View style={styles.controls}>
        <Pressable style={[styles.btn, styles.playBtn]} onPress={duel.autoPlay} disabled={duel.autoplaying}>
          <Text style={styles.btnText}>{duel.autoplaying ? '⏳ auto-playing…' : '▶ Auto-play (benchmark)'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1020' },
  segRow: { flexDirection: 'row', gap: 8, padding: 12 },
  seg: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10, backgroundColor: '#111827', borderWidth: 2, borderColor: '#1e293b' },
  segOn: { borderColor: '#38bdf8', backgroundColor: '#0c4a6e' },
  segTxt: { color: '#94a3b8', fontWeight: '800', fontSize: 14 }, segTxtOn: { color: '#e2e8f0' },

  root: { flex: 1, paddingHorizontal: 20, paddingTop: 4 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h1: { color: '#f8fafc', fontSize: 28, fontWeight: '800' },
  sub: { color: '#64748b', fontSize: 12, marginTop: 2 },

  timerWrap: { alignItems: 'flex-end', gap: 4, width: 120 },
  barTrack: { width: 110, height: 6, borderRadius: 3, backgroundColor: '#1e293b', overflow: 'hidden' },
  barFill: { width: '100%', height: '100%', backgroundColor: '#38bdf8', transformOrigin: 'left' },
  barFillNaive: { height: '100%', backgroundColor: '#f59e0b' },
  timer: { color: '#38bdf8', fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },

  board: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 14, gap: 10 },
  side: { flex: 1, backgroundColor: '#111827', borderRadius: 14, borderWidth: 2, borderColor: '#1e293b', padding: 12, alignItems: 'center' },
  lead: { borderColor: '#22c55e' },
  sideLabel: { color: '#94a3b8', fontSize: 12, fontWeight: '700' }, sideScore: { color: '#f8fafc', fontSize: 34, fontWeight: '800' },
  vs: { color: '#475569', fontSize: 13, fontWeight: '700' },

  flag: { backgroundColor: '#7f1d1d', borderRadius: 12, padding: 12, marginTop: 12 },
  flagTitle: { color: '#fecaca', fontSize: 15, fontWeight: '800' }, flagBody: { color: '#fca5a5', fontSize: 12, marginTop: 2 },

  panel: { marginTop: 14, alignItems: 'center' },
  prompt: { color: '#f8fafc', fontSize: 46, fontWeight: '800', textAlign: 'center' },
  cells: { flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 10, justifyContent: 'center' },
  cell: { width: 16, height: 16, borderRadius: 3, backgroundColor: '#1d4ed8' },

  input: { marginTop: 16, backgroundColor: '#111827', borderRadius: 14, borderWidth: 2, borderColor: '#38bdf8', color: '#f8fafc', fontSize: 26, fontWeight: '800', textAlign: 'center', paddingVertical: 12 },
  finish: { color: '#f8fafc', fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 16 },

  statBox: { marginTop: 14, backgroundColor: '#111827', borderRadius: 12, padding: 14, borderWidth: 2, borderColor: '#1e293b' },
  stat: { color: '#cbd5e1', fontSize: 15, fontWeight: '700' }, statNum: { color: '#38bdf8', fontSize: 20, fontWeight: '800' },
  statSub: { color: '#64748b', fontSize: 12, marginTop: 3 },

  controls: { flexDirection: 'row', gap: 12, marginTop: 'auto', marginBottom: 14 },
  btn: { flex: 1, borderRadius: 14, paddingVertical: 14, alignItems: 'center' }, playBtn: { backgroundColor: '#1d4ed8' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});
