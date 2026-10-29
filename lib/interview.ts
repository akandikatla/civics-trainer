/**
 * Interview session state and question selection.
 *
 * Contains no grading at all. Asking a question is pure bookkeeping: the wording
 * is already in questions.json, and a real USCIS officer reads it verbatim.
 * Grading lives in `grader.ts`. Everything here runs in the browser; sessions are
 * in memory and mastery data persists in localStorage via `store.ts`.
 */

import {
  applyVerdict,
  countRequired,
  dueConfirmIds,
  dueLapsedIds,
  examPlan,
  isMastered,
  nextQuestionId,
  recordOf,
  reviseLastVerdict,
  statsBySection,
  tallyExam,
  weakIds,
  type ExamTally,
  type Mode,
  type Progress,
  type QRecord,
  type Question,
  type Verdict,
} from "./mastery";
import {
  appendSession,
  loadProgress,
  loadQuestions,
  questionById,
  removeSession,
  replaceSession,
  saveProgress,
  type SessionRecord,
} from "./store";
import { isGradeable, ungradeableIds } from "./local-answers";

export interface Interview {
  id: string;
  mode: Mode;
  starredOnly: boolean;
  plan: number[];
  planIndex: number;
  currentQuestionId: number | null;
  verdicts: Verdict[];
  results: Array<{ questionId: number; verdict: string; transcript: string; selfGraded?: boolean }>;
  startedAt: string;
  finished: boolean;
  /** Loop mode: which pass through the bank we are on, 1-based. */
  cycle: number;
  /** Loop mode: ids already served in the current cycle, so none repeats. */
  askedThisCycle: Set<number>;
  /** Loop mode: how a question was chosen, for the UI to explain itself. */
  lastPick: "new" | "repair" | "confirm" | null;
  /** Loop mode: which review kind used the last review slot, so they alternate. */
  lastReviewKind: "repair" | "confirm" | null;
  /**
   * The most recently recorded verdict, with the question's record as it stood
   * before, so a self-grade override can replace it without double counting.
   */
  lastTurn: LastTurn | null;
  /** How the session ended, once finished. */
  finishReason: NextStep["reason"] | null;
}

export interface LastTurn {
  questionId: number;
  verdict: Verdict;
  prior: QRecord | null;
  /** Index into `verdicts` / `results`. */
  index: number;
  revised: boolean;
}

/** In-memory; only the mastery data in localStorage needs to survive a reload. */
const interviews = new Map<string, Interview>();

/** Forget every in-flight session (used by "Reset progress"). */
export function clearInterviews(): void {
  interviews.clear();
}

export function createInterview(mode: Mode, starredOnly = false): Interview {
  const pool = poolFor(starredOnly);

  const interview: Interview = {
    id: `iv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    mode,
    starredOnly,
    // exam: 20 section-weighted questions. loop: every question, shuffled.
    plan: mode === "exam" ? examPlan(pool) : mode === "loop" ? shuffleIds(pool) : [],
    planIndex: 0,
    currentQuestionId: null,
    verdicts: [],
    results: [],
    startedAt: new Date().toISOString(),
    finished: false,
    cycle: 1,
    askedThisCycle: new Set(),
    lastPick: null,
    lastReviewKind: null,
    lastTurn: null,
    finishReason: null,
  };
  interviews.set(interview.id, interview);
  return interview;
}

/** Every id in the pool, in random order. `examPlan` shuffles all when length >= size. */
const shuffleIds = (pool: Question[]): number[] => examPlan(pool, Math.random, pool.length);

export const getInterview = (id: string): Interview | undefined => interviews.get(id);

export interface NextStep {
  done: boolean;
  reason?: "passed" | "finished" | "all_mastered";
  question?: Question;
  answersRequired?: number;
  /** How this question was chosen: fresh coverage, a repair, or a mastery confirmation. */
  pick?: "new" | "repair" | "confirm";
  cycle?: number;
  cyclePosition?: number;
  cycleTotal?: number;
}

/**
 * Askable questions: starred-only if requested, and never one whose answers are
 * placeholders. Asking an ungradeable question guarantees a wrong verdict, so it is
 * skipped until local answers exist for it.
 */
export function poolFor(starredOnly: boolean): Question[] {
  const bank = loadQuestions();
  return bank.filter((q) => (starredOnly ? q.starred : true) && isGradeable(q));
}

/** Ids the drill is skipping because they need local answers. */
export const skippedIds = (): number[] => ungradeableIds(loadQuestions());

/** Advance to the next question. Pure bookkeeping: no network, no model. */
export function advance(interview: Interview): NextStep {
  const pool = poolFor(interview.starredOnly);

  if (interview.mode === "loop") return advanceLoop(interview, pool);

  const tally = tallyExam(interview.verdicts);
  const outOfPlan = interview.mode === "exam" && interview.planIndex >= interview.plan.length;

  if (interview.mode === "exam" && (tally.passed || tally.failed || outOfPlan)) {
    return finish(interview, tally.passed ? "passed" : "finished");
  }

  let id: number | null;
  if (interview.mode === "exam") {
    id = interview.plan[interview.planIndex];
    interview.planIndex += 1;
  } else {
    id = nextQuestionId(loadProgress(), pool.map((q) => q.id));
    if (id === null) return finish(interview, "all_mastered");
  }

  const question = questionById(id!);
  if (!question) return finish(interview, "finished");

  interview.currentQuestionId = question.id;
  return { done: false, question, answersRequired: countRequired(question.question) };
}

/**
 * Loop mode: an endless, intelligent sweep of the whole bank.
 *
 * Each cycle serves every question in the pool exactly once, in random order, so
 * nothing is ever skipped. Between those, any question you missed is re-injected
 * as soon as it comes due (a few questions later), which is what makes the loop
 * intelligent rather than a flashcard carousel. Reaching the end of a cycle
 * reshuffles and starts the next one, forever.
 */
function advanceLoop(interview: Interview, pool: Question[]): NextStep {
  const progress: Progress = loadProgress();
  const ids = pool.map((q) => q.id);

  // The loop juggles three jobs, and each one starves the others if left greedy:
  //
  //   new     - cover every question in the bank
  //   repair  - re-ask something you got wrong
  //   confirm - land the second correct answer that converts a question to mastered
  //
  // A review slot is taken only after a `new` question, capping reviews at half the
  // questions so the sweep always advances. Within that slot, repair and confirm
  // alternate, so a pile of wrong answers cannot indefinitely block mastery from
  // being locked in (or the reverse).
  let id: number | undefined;
  let pick: "new" | "repair" | "confirm";

  const reviewSlot = interview.lastPick === "new" || interview.lastPick === null;
  const repairs = reviewSlot ? dueLapsedIds(progress, ids, interview.currentQuestionId) : [];
  const confirms = reviewSlot ? dueConfirmIds(progress, ids, interview.currentQuestionId) : [];

  // Take whichever kind did not get the previous review slot; fall back to the other.
  const preferConfirm = interview.lastReviewKind === "repair";
  const [first, second] = preferConfirm ? [confirms, repairs] : [repairs, confirms];
  const chosen = first[0] ?? second[0];
  const chosenKind: "repair" | "confirm" =
    first[0] !== undefined ? (preferConfirm ? "confirm" : "repair") : preferConfirm ? "repair" : "confirm";

  if (chosen !== undefined) {
    id = chosen;
    pick = chosenKind;
    interview.lastReviewKind = chosenKind;
  } else {
    // Walk the shuffled cycle, skipping anything already served this cycle.
    while (interview.planIndex < interview.plan.length) {
      const candidate = interview.plan[interview.planIndex];
      interview.planIndex += 1;
      if (!interview.askedThisCycle.has(candidate)) {
        id = candidate;
        break;
      }
    }
    // Cycle exhausted: reshuffle and begin the next pass. The loop never ends.
    if (id === undefined) {
      interview.cycle += 1;
      interview.plan = shuffleIds(pool);
      interview.planIndex = 1;
      interview.askedThisCycle = new Set();
      id = interview.plan[0];
    }
    pick = "new";
  }

  const question = id === undefined ? undefined : questionById(id);
  if (!question) return finish(interview, "finished");

  interview.currentQuestionId = question.id;
  interview.askedThisCycle.add(question.id);
  interview.lastPick = pick;

  return {
    done: false,
    question,
    answersRequired: countRequired(question.question),
    pick,
    cycle: interview.cycle,
    cyclePosition: interview.askedThisCycle.size,
    cycleTotal: pool.length,
  };
}

function sessionRecordOf(interview: Interview): SessionRecord {
  const tally = tallyExam(interview.verdicts);
  return {
    startedAt: interview.startedAt,
    endedAt: new Date().toISOString(),
    mode: interview.mode,
    asked: tally.asked,
    correct: tally.correct,
    passed: tally.passed,
    results: interview.results.map((r) => ({ ...r })),
  };
}

export function finish(interview: Interview, reason: NextStep["reason"]): NextStep {
  if (!interview.finished) {
    interview.finished = true;
    interview.finishReason = reason;
    interview.currentQuestionId = null;
    appendSession(sessionRecordOf(interview));
  }
  return { done: true, reason };
}

export interface RecordOutcome {
  streak: number;
  mastered: boolean;
  tally: ExamTally;
}

/** Commit a verdict for the open question. Deterministic; the model never writes state. */
export function record(
  interview: Interview,
  questionId: number,
  verdict: Verdict,
  transcript: string,
): RecordOutcome {
  const before = loadProgress();
  const prior = before.q[String(questionId)] ?? null;
  const progress = applyVerdict(before, questionId, verdict);
  saveProgress(progress);

  interview.verdicts.push(verdict);
  interview.results.push({ questionId, verdict, transcript });
  interview.currentQuestionId = null;
  interview.lastTurn = {
    questionId,
    verdict,
    prior: prior ? { ...prior } : null,
    index: interview.verdicts.length - 1,
    revised: false,
  };

  const rec = recordOf(progress, questionId);
  return { streak: rec.streak, mastered: isMastered(rec), tally: tallyExam(interview.verdicts) };
}

/** Can the last recorded verdict still be self-graded? Only a fresh `wrong`, once. */
export function canRevise(interview: Interview): boolean {
  const t = interview.lastTurn;
  return Boolean(t && t.verdict === "wrong" && !t.revised);
}

export interface ReviseOutcome extends RecordOutcome {
  questionId: number;
  /** A finished exam that the correction brought back to life. */
  reopened: boolean;
}

/**
 * Self-grade override: replace the last `wrong` with `correct` or `risky`.
 *
 * Progress is rewritten with `reviseLastVerdict`, so the attempt is counted once
 * with the corrected verdict. The session's own tally and results are patched in
 * place. If the wrong verdict had ended an exam (twelve out of reach) and the
 * correction makes twelve reachable again, the exam reopens and its stored
 * session record is withdrawn; `finish()` writes a fresh one later. Returns null
 * when there is nothing that may be revised.
 */
export function revise(interview: Interview, verdict: Exclude<Verdict, "wrong">): ReviseOutcome | null {
  const turn = interview.lastTurn;
  if (!turn || !canRevise(interview)) return null;

  const progress = reviseLastVerdict(loadProgress(), turn.questionId, verdict, turn.prior);
  if (!progress) return null;
  saveProgress(progress);

  interview.verdicts[turn.index] = verdict;
  const result = interview.results[turn.index];
  if (result) interview.results[turn.index] = { ...result, verdict, selfGraded: true };
  turn.verdict = verdict;
  turn.revised = true;

  const tally = tallyExam(interview.verdicts);
  let reopened = false;
  if (interview.finished) {
    const stillOver =
      interview.mode !== "exam" || tally.passed || tally.failed || interview.planIndex >= interview.plan.length;
    if (stillOver) {
      replaceSession(sessionRecordOf(interview));
    } else {
      removeSession(interview.startedAt);
      interview.finished = false;
      interview.finishReason = null;
      reopened = true;
    }
  }

  const rec = recordOf(progress, turn.questionId);
  return { questionId: turn.questionId, streak: rec.streak, mastered: isMastered(rec), tally, reopened };
}

export function masteryTotals() {
  // Denominator counts only askable questions; the eight placeholders would
  // otherwise make 128/128 unreachable no matter how well you did.
  const pool = poolFor(false);
  const progress = loadProgress();
  return {
    mastered: pool.filter((q) => isMastered(recordOf(progress, q.id))).length,
    total: pool.length,
    skipped: skippedIds().length,
  };
}

/** Closing-summary data for the end of an interview. */
export function summary() {
  const bank = poolFor(false);
  const progress = loadProgress();
  const starred = bank.filter((q) => q.starred);
  return {
    ...masteryTotals(),
    starredMastered: starred.filter((q) => isMastered(recordOf(progress, q.id))).length,
    starredTotal: starred.length,
    sections: statsBySection(bank, progress),
    weakest: weakIds(bank, progress).slice(0, 8),
  };
}

export { countRequired };
