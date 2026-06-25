/**
 * The Blitz/DMAS duel domain model — a deterministic, pure reducer.
 *
 * The key insight that makes prediction trivially accurate for Matiks: the client already
 * has the decrypted question, so it KNOWS the correct answer locally. Correctness is
 * deterministic, so optimistic prediction is essentially always right and reconciliation
 * almost never rolls back. (Scoring constant from the captured protocol: correct × 4.)
 */

export interface DuelState {
  score: number;
  questionIndex: number;
  /** questionId -> wasCorrect; also makes re-applying the same answer idempotent. */
  answered: Record<string, boolean>;
}

export interface AnswerInput {
  seq: number;
  questionId: string;
  submittedValue: number;
  /** Known locally because the question was decrypted on the client. */
  correctValue: number;
  /** Client submit timestamp. */
  timeOfSubmission: number;
}

export const BLITZ_POINTS_PER_CORRECT = 4;

export const initialDuelState: DuelState = Object.freeze({
  score: 0,
  questionIndex: 0,
  answered: {},
});

/** Pure reducer: apply one answer. Idempotent per questionId. Never mutates `state`. */
export function applyAnswer(state: DuelState, input: AnswerInput): DuelState {
  if (Object.prototype.hasOwnProperty.call(state.answered, input.questionId)) {
    return state; // already answered — ignore duplicates/replays
  }
  const correct = input.submittedValue === input.correctValue;
  return {
    score: state.score + (correct ? BLITZ_POINTS_PER_CORRECT : 0),
    questionIndex: state.questionIndex + 1,
    answered: { ...state.answered, [input.questionId]: correct },
  };
}

export const seqOf = (input: AnswerInput): number => input.seq;

// Cheap clone for the prediction hot path (avoids structuredClone); answered is a flat map.
export function cloneDuelState(s: DuelState): DuelState {
  return { score: s.score, questionIndex: s.questionIndex, answered: { ...s.answered } };
}

// Cheap value-equality for the prediction hot path (avoids the default double JSON.stringify).
export function duelStateEqual(a: DuelState, b: DuelState): boolean {
  if (a === b) return true;
  if (a.score !== b.score || a.questionIndex !== b.questionIndex) return false;
  const ak = Object.keys(a.answered);
  if (ak.length !== Object.keys(b.answered).length) return false;
  for (const k of ak) {
    if (a.answered[k] !== b.answered[k]) return false;
  }
  return true;
}
