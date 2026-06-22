/**
 * MatiksRealtime off-thread decrypt — visual test harness (one screen).
 *
 * The whole point of this screen is to make "is the JS thread free?" *visible*:
 *
 *   • A spinner driven by requestAnimationFrame updates a rotation EVERY FRAME. rAF callbacks
 *     run on the JS thread, so if the JS thread is blocked the spinner FREEZES. It is our live
 *     "JS thread free?" indicator. (A Reanimated worklet would instead keep spinning on the UI
 *     thread regardless — see 01-core-concepts/03-interactivity-and-gestures.md §4 and
 *     02-architecture-and-performance/01-threading-model.md §1b. We use rAF *on purpose* so the
 *     freeze is observable.)
 *
 *   • Button A decrypts 75 questions with pure-JS AES on the JS thread → spinner FREEZES.
 *   • Button B hands the same 75 blobs to the MatiksRealtime Nitro module → spinner KEEPS SPINNING.
 *
 * Record the screen, tap A then B, and the difference is unmistakable.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { selfTestAES } from './aes';
import {
  decryptOffThread,
  decryptOffThreadPacked,
  decryptOnJsThread,
  hasNativeModule,
} from './decrypt';
import { DEMO_KEY, DEMO_KEY_STRING, generateBank, QUESTION_COUNT } from './questions';

// 60fps assumption for the "frames dropped" estimate (16.67 ms/frame — threading-model.md §1a).
const FRAME_MS = 1000 / 60;

interface PathResult {
  ms: number;
  count: number;
  /** Frames the spinner missed while this path ran (max of the on-screen counter delta and the
   *  theoretical elapsed/16.67ms — the JS path freezes the counter so we also derive from ms). */
  framesDropped: number;
  jsStayedFree: boolean;
  /** Button B only: true if the real native module ran, false if the simulated fallback ran. */
  usedNative?: boolean;
}

export default function App() {
  // ── synthetic bank (generated once) ──
  const bankRef = useRef(generateBank());
  const bank = bankRef.current;

  // ── rAF "JS thread free?" spinner ──
  const [angle, setAngle] = useState(0);
  // frameCountRef increments once per actually-fired animation frame. A frozen JS thread can't
  // increment it — that gap is our empirical dropped-frame measure.
  const frameCountRef = useRef(0);
  const angleRef = useRef(0);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (last) {
        // advance proportional to elapsed so the spin speed is smooth, ~180°/s
        angleRef.current = (angleRef.current + (t - last) * 0.18) % 360;
        setAngle(angleRef.current);
      }
      last = t;
      frameCountRef.current += 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── results ──
  const [aesOk] = useState(() => selfTestAES());
  const [running, setRunning] = useState<null | 'A' | 'B' | 'C'>(null);
  const [resultA, setResultA] = useState<PathResult | null>(null);
  const [resultB, setResultB] = useState<PathResult | null>(null);
  const [resultC, setResultC] = useState<PathResult | null>(null);

  // ── Button A: decrypt ON the JS thread (current approach) ──
  const runOnJsThread = useCallback(() => {
    setRunning('A');
    // Defer one frame so the "running" state paints before we block the thread.
    requestAnimationFrame(() => {
      const framesBefore = frameCountRef.current;
      const t0 = Date.now();
      const { questions } = decryptOnJsThread(bank.blobs, DEMO_KEY);
      const ms = Date.now() - t0;
      const framesAfter = frameCountRef.current;
      // While blocked, rAF cannot fire, so (framesAfter - framesBefore) is ~0. The true dropped
      // count is how many frames *should* have fired in `ms`.
      const observedAdvanced = framesAfter - framesBefore;
      const expected = Math.round(ms / FRAME_MS);
      const framesDropped = Math.max(0, expected - observedAdvanced);
      setResultA({
        ms,
        count: questions.length,
        framesDropped,
        jsStayedFree: false, // by construction — this path blocks the JS thread
      });
      setRunning(null);
    });
  }, [bank]);

  // ── Button B: decrypt OFF the JS thread (Nitro module) ──
  const runOffThread = useCallback(async () => {
    setRunning('B');
    const framesBefore = frameCountRef.current;
    const t0 = Date.now();
    const { questions, usedNative } = await decryptOffThread(bank.blobs, DEMO_KEY, DEMO_KEY_STRING);
    const ms = Date.now() - t0;
    const framesAfter = frameCountRef.current;
    const observedAdvanced = framesAfter - framesBefore;
    const expected = Math.max(1, Math.round(ms / FRAME_MS));
    // JS stayed free if the spinner kept firing for most of the elapsed window.
    const framesDropped = Math.max(0, expected - observedAdvanced);
    const jsStayedFree = observedAdvanced >= expected * 0.5;
    setResultB({ ms, count: questions.length, framesDropped, jsStayedFree, usedNative });
    setRunning(null);
  }, [bank]);

  // ── Button C: decrypt OFF the JS thread, ONE JSI crossing each way (packed) ──
  const runOffThreadPacked = useCallback(async () => {
    setRunning('C');
    const framesBefore = frameCountRef.current;
    const t0 = Date.now();
    const { count, usedNative } = await decryptOffThreadPacked(bank.blobs, DEMO_KEY_STRING);
    const ms = Date.now() - t0;
    const framesAfter = frameCountRef.current;
    const observedAdvanced = framesAfter - framesBefore;
    const expected = Math.max(1, Math.round(ms / FRAME_MS));
    const framesDropped = Math.max(0, expected - observedAdvanced);
    const jsStayedFree = observedAdvanced >= expected * 0.5;
    setResultC({ ms, count, framesDropped, jsStayedFree, usedNative });
    setRunning(null);
  }, [bank]);

  const deviceNote =
    `${Platform.OS} ${Platform.Version ?? ''}`.trim() +
    ` · ${QUESTION_COUNT} questions · ${(bank.totalCipherBytes / 1024).toFixed(1)} KB ciphertext`;

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Title + device note */}
        <Text style={styles.title}>Off-Thread Decrypt</Text>
        <Text style={styles.subtitle}>MatiksRealtime · Nitro module demo</Text>
        <Text style={styles.device}>{deviceNote}</Text>
        <Text style={[styles.device, { color: aesOk ? '#16a34a' : '#dc2626' }]}>
          AES-256 FIPS-197 self-test: {aesOk ? 'PASS' : 'FAIL'}
          {hasNativeModule ? ' · native module: LINKED' : ' · native module: not present (simulated B)'}
        </Text>

        {/* The "is the JS thread free?" spinner */}
        <View style={styles.spinnerWrap}>
          <View style={[styles.spinner, { transform: [{ rotate: `${angle}deg` }] }]}>
            <View style={styles.spinnerTick} />
          </View>
          <Text style={styles.spinnerLabel}>
            JS-thread animation{'\n'}(freezes if the thread blocks)
          </Text>
        </View>

        {/* Button A */}
        <Pressable
          onPress={runOnJsThread}
          disabled={running !== null}
          style={({ pressed }: { pressed: boolean }) => [
            styles.button,
            styles.buttonA,
            (pressed || running === 'A') && styles.buttonPressed,
            running !== null && running !== 'A' && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonTitle}>A · Decrypt 75 ON the JS thread</Text>
          <Text style={styles.buttonSub}>current approach · pure-JS AES · will FREEZE the spinner</Text>
        </Pressable>

        {/* Button B */}
        <Pressable
          onPress={runOffThread}
          disabled={running !== null}
          style={({ pressed }: { pressed: boolean }) => [
            styles.button,
            styles.buttonB,
            (pressed || running === 'B') && styles.buttonPressed,
            running !== null && running !== 'B' && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonTitle}>B · Decrypt OFF-thread (Nitro)</Text>
          <Text style={styles.buttonSub}>MatiksRealtime.decryptQuestions · 75 strings across JSI</Text>
        </Pressable>

        {/* Button C — off-thread, but ONE string crosses the bridge each way */}
        <Pressable
          onPress={runOffThreadPacked}
          disabled={running !== null}
          style={({ pressed }: { pressed: boolean }) => [
            styles.button,
            styles.buttonC,
            (pressed || running === 'C') && styles.buttonPressed,
            running !== null && running !== 'C' && styles.buttonDisabled,
          ]}
        >
          <Text style={styles.buttonTitle}>C · Off-thread + PACKED (1 JSI crossing)</Text>
          <Text style={styles.buttonSub}>decryptQuestionsPacked · one string in, one out</Text>
        </Pressable>

        {running && (
          <Text style={styles.runningNote}>
            Running {running === 'A' ? 'A (JS thread)…' : running === 'B' ? 'B (off-thread)…' : 'C (packed)…'} watch the spinner
          </Text>
        )}

        {/* Results panel — side by side */}
        <View style={styles.results}>
          <Text style={styles.resultsTitle}>Results</Text>
          <View style={styles.resultsRow}>
            <ResultCard label="A · JS thread" tint="#f59e0b" result={resultA} />
            <ResultCard label="B · Off-thread" tint="#22c55e" result={resultB} />
          </View>
          <View style={[styles.resultsRow, { marginTop: 12 }]}>
            <ResultCard label="C · Off-thread + packed" tint="#38bdf8" result={resultC} />
            <View style={{ flex: 1 }} />
          </View>

          {resultA && resultB && (
            <View style={styles.verdict}>
              <Text style={styles.verdictLine}>
                Off-thread is{' '}
                <Text style={styles.verdictStrong}>
                  {resultA.ms > 0 ? `${(resultA.ms / Math.max(1, resultB.ms)).toFixed(1)}×` : '—'}
                </Text>{' '}
                faster end-to-end here, and dropped{' '}
                <Text style={styles.verdictStrong}>
                  {resultA.framesDropped - resultB.framesDropped}
                </Text>{' '}
                fewer frames.
              </Text>
            </View>
          )}

          {resultB && resultC && (
            <View style={styles.verdict}>
              <Text style={styles.verdictLine}>
                Packed (C) is{' '}
                <Text style={styles.verdictStrong}>
                  {resultC.ms > 0 ? `${(resultB.ms / Math.max(1, resultC.ms)).toFixed(1)}×` : '—'}
                </Text>{' '}
                faster than B — JS thread free during C:{' '}
                <Text style={styles.verdictStrong}>{resultC.jsStayedFree ? 'YES ✓' : 'no ✗'}</Text>
              </Text>
            </View>
          )}
        </View>

        <Text style={styles.footnote}>
          rAF runs on the JS thread, so the spinner is a live readout of JS-thread availability. A
          Reanimated worklet would spin on the UI thread and hide the freeze — we use rAF on purpose.
        </Text>
      </ScrollView>
    </View>
  );
}

function ResultCard({
  label,
  tint,
  result,
}: {
  label: string;
  tint: string;
  result: PathResult | null;
}) {
  return (
    <View style={[styles.card, { borderColor: tint }]}>
      <Text style={[styles.cardLabel, { color: tint }]}>{label}</Text>
      {result ? (
        <>
          <Text style={styles.cardBig}>{result.ms} ms</Text>
          <Text style={styles.cardLine}>decrypted: {result.count}</Text>
          <Text style={styles.cardLine}>frames dropped: {result.framesDropped}</Text>
          <Text style={[styles.cardLine, styles.cardFree]}>
            JS thread free: {result.jsStayedFree ? '✅' : '❌'}
          </Text>
          {result.usedNative === false && (
            <Text style={styles.cardSim}>simulated (no native binary)</Text>
          )}
          {result.usedNative === true && <Text style={styles.cardSim}>native module</Text>}
        </>
      ) : (
        <Text style={styles.cardEmpty}>— not run —</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b1020' },
  scroll: { padding: 20, paddingTop: 64, paddingBottom: 48 },

  title: { color: '#f8fafc', fontSize: 30, fontWeight: '800', letterSpacing: 0.3 },
  subtitle: { color: '#94a3b8', fontSize: 15, marginTop: 2, fontWeight: '600' },
  device: { color: '#64748b', fontSize: 13, marginTop: 8 },

  spinnerWrap: {
    alignItems: 'center',
    marginVertical: 28,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 18,
  },
  spinner: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 6,
    borderColor: '#1e293b',
    borderTopColor: '#38bdf8',
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  spinnerTick: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#38bdf8',
    marginTop: -3,
  },
  spinnerLabel: { color: '#cbd5e1', fontSize: 14, fontWeight: '600', lineHeight: 20 },

  button: {
    borderRadius: 16,
    paddingVertical: 20,
    paddingHorizontal: 18,
    marginTop: 14,
  },
  buttonA: { backgroundColor: '#b45309' },
  buttonB: { backgroundColor: '#15803d' },
  buttonC: { backgroundColor: '#0e7490' },
  buttonPressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },
  buttonDisabled: { opacity: 0.4 },
  buttonTitle: { color: '#fff', fontSize: 19, fontWeight: '800' },
  buttonSub: { color: '#f1f5f9', fontSize: 13, marginTop: 4, opacity: 0.9 },

  runningNote: {
    color: '#fbbf24',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 16,
  },

  results: { marginTop: 26 },
  resultsTitle: { color: '#e2e8f0', fontSize: 18, fontWeight: '800', marginBottom: 10 },
  resultsRow: { flexDirection: 'row', gap: 12 },
  card: {
    flex: 1,
    backgroundColor: '#111827',
    borderRadius: 14,
    borderWidth: 2,
    padding: 14,
  },
  cardLabel: { fontSize: 13, fontWeight: '800', marginBottom: 6 },
  cardBig: { color: '#f8fafc', fontSize: 28, fontWeight: '800' },
  cardLine: { color: '#cbd5e1', fontSize: 13, marginTop: 4 },
  cardFree: { fontWeight: '700', marginTop: 6 },
  cardSim: { color: '#64748b', fontSize: 11, marginTop: 6, fontStyle: 'italic' },
  cardEmpty: { color: '#475569', fontSize: 14, marginTop: 10 },

  verdict: {
    marginTop: 16,
    backgroundColor: '#0f172a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  verdictLine: { color: '#cbd5e1', fontSize: 14, lineHeight: 21 },
  verdictStrong: { color: '#38bdf8', fontWeight: '800' },

  footnote: { color: '#475569', fontSize: 12, lineHeight: 18, marginTop: 24 },
});
