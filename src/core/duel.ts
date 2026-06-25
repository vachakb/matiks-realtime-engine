// Blitz/DMAS duel reducer — pure + deterministic. The client has the decrypted question, so it
// knows the correct answer locally; prediction is essentially always right (rollbacks ≈ 0).

export interface DuelState {
  score: number;
  questionIndex: number;
  answered: Record<string, boolean>; // questionId -> wasCorrect (also makes re-apply idempotent)
}

export interface AnswerInput {
  seq: number;
  questionId: string;
  submittedValue: number;
  correctValue: number; // known locally — the question was decrypted on the client
  timeOfSubmission: number;
}

export const BLITZ_POINTS_PER_CORRECT = 4;

export const initialDuelState: DuelState = Object.freeze({
  score: 0,
  questionIndex: 0,
  answered: {},
});

// Pure, idempotent per questionId. Never mutates `state`.
export function applyAnswer(state: DuelState, input: AnswerInput): DuelState {
  if (Object.prototype.hasOwnProperty.call(state.answered, input.questionId)) {
    return state; // already answered
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
