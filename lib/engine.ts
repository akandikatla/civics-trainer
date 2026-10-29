/**
 * The interview, run entirely in the browser.
 *
 * This replaces the old /api/interview, /api/stats and /api/prewarm routes. The
 * page calls these functions directly; there is no server and no network.
 * Grading runs on this device (lib/grader.ts: the bundled model once loaded,
 * the offline matcher before that). Response shapes match what the routes used
 * to return, so the UI code reads the same fields.
 */

import {
  advance,
  canRevise,
  countRequired,
  createInterview,
  finish,
  getInterview,
  masteryTotals,
  poolFor,
  record,
  revise,
  skippedIds,
  summary,
  type NextStep,
} from "./interview";
import { feedbackFor, grade, type GradePipeline, type GradeVerdict } from "./grader";
import {
  EXAM_PASS_MARK,
  MASTERY_STREAK,
  isMastered,
  recordOf,
  statsBySection,
  tallyExam,
  weakIds,
  type ExamTally,
  type Mode,
  type Verdict,
} from "./mastery";
import { loadProgress, questionById } from "./store";
import { withResolvedAnswers } from "./local-answers";
import { elapsedUs, startTimer } from "./timing";

export type { Mode };
export type CellState = "mastered" | "confirm" | "lapsed" | "unseen";

export interface TurnResponse {
  interviewId: string;
  mode: Mode;
  /** The whole officer line, for display or a single-shot fallback. */
  say: string;
  /** Spoken in order. Each part is a fixed line that can have bundled audio. */
  sayParts: string[];
  sayFeedback?: string | null;
  sayQuestion?: string | null;
  question?: string | null;
  questionOnly: string | null;
  currentQuestionId: number | null;
  section?: string;
  starred?: boolean;
  pick?: "new" | "repair" | "confirm" | null;
  cycle?: number | null;
  cyclePosition?: number | null;
  cycleTotal?: number | null;
  verdict: GradeVerdict | null;
  matchedAnswer?: string | null;
  officialAnswers?: string[] | null;
  citationRejected?: boolean;
  questionMastered?: boolean;
  /** Id of the question the verdict is about (the one just answered). */
  answeredQuestionId?: number | null;
  /** True when the verdict may still be self-graded with the override buttons. */
  canRevise?: boolean;
  /** True when the verdict shown came from the applicant's own override. */
  selfGraded?: boolean;
  finished: boolean;
  tally: ExamTally;
  mastery: { mastered: number; total: number; skipped: number };
  timing?: { gradeUs: number; totalUs: number; fastPath?: boolean; pipeline?: GradePipeline };
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly expired = false,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

const MODES: Mode[] = ["exam", "practice", "loop"];

/** Every fixed opening line, so the audio bundler can enumerate them. */
export const ALL_MASTERED_LINE = "Everything in this set is already mastered. Well done.";
export function greetingFor(mode: Mode, cycleTotal?: number | null): string {
  return mode === "exam"
    ? "Good morning. This is the civics portion of your naturalization interview."
    : mode === "loop"
      ? `Starting a full pass through all ${cycleTotal} questions.`
      : "Starting a practice drill on your weakest questions.";
}

export function closingFor(tally: ExamTally): string {
  return tally.passed
    ? `You answered ${tally.correct} correctly, so you have passed the civics test.`
    : `That is the end. You answered ${tally.correct} of ${tally.asked} correctly, and ${EXAM_PASS_MARK} are needed to pass.`;
}

export const masteredLine = (mastered: number, total: number) =>
  `You have mastered ${mastered} of ${total} questions.`;

export const CORRECTION_PASSED_LINE = "With that correction, you have passed the civics test.";
export const CORRECTION_REOPENED_LINE = "With that correction, the interview continues.";

function questionFields(step: NextStep) {
  return {
    question: step.question!.question,
    questionOnly: step.question!.question,
    currentQuestionId: step.question!.id,
    section: step.question!.section,
    starred: step.question!.starred,
    pick: step.pick ?? null,
    cycle: step.cycle ?? null,
    cyclePosition: step.cyclePosition ?? null,
    cycleTotal: step.cycleTotal ?? null,
  };
}

/** Start a new session. No grading: the question text is bundled. */
export function startInterview(modeIn: Mode, starredOnly = false): TurnResponse {
  const total = startTimer();
  const mode = MODES.includes(modeIn) ? modeIn : "exam";
  const interview = createInterview(mode, starredOnly);
  const step = advance(interview);

  if (step.done || !step.question) {
    return {
      interviewId: interview.id,
      mode,
      say: ALL_MASTERED_LINE,
      sayParts: [ALL_MASTERED_LINE],
      question: null,
      questionOnly: null,
      currentQuestionId: null,
      verdict: null,
      finished: true,
      tally: tallyExam([]),
      mastery: masteryTotals(),
      timing: { gradeUs: 0, totalUs: elapsedUs(total) },
    };
  }

  const greeting = greetingFor(mode, step.cycleTotal);
  return {
    interviewId: interview.id,
    mode,
    say: `${greeting} ${step.question.question}`,
    sayParts: [greeting, step.question.question],
    sayFeedback: greeting,
    sayQuestion: step.question.question,
    ...questionFields(step),
    verdict: null,
    finished: false,
    tally: tallyExam([]),
    mastery: masteryTotals(),
    timing: { gradeUs: 0, totalUs: elapsedUs(total) },
  };
}

/** Grade one answer, record it, and open the next question. */
export async function answer(interviewId: string, transcriptIn: string): Promise<TurnResponse> {
  const total = startTimer();
  const interview = getInterview(interviewId);
  if (!interview) throw new EngineError("That session is no longer active. Start a new one.", true);
  if (interview.finished) throw new EngineError("This session is already over.");

  const transcript = transcriptIn.trim();
  if (!transcript) throw new EngineError("No answer was heard. Try again.");

  const openId = interview.currentQuestionId;
  const question = openId === null ? undefined : questionById(openId);
  if (!question) throw new EngineError("No question is open in this session.");

  // Swap placeholder answers for the Minnesota ones before grading.
  const gradable = withResolvedAnswers(question);
  const graded = await grade(gradable, transcript, countRequired(gradable.question));
  const feedback = feedbackFor(graded.verdict, gradable.answers, graded.matchedAnswer);
  const timing = { gradeUs: graded.latencyUs, totalUs: 0, fastPath: Boolean(graded.fastPath), pipeline: graded.pipeline };

  // Garbled audio is not an answer: re-ask without consuming the question.
  if (graded.verdict === "unintelligible") {
    return {
      interviewId: interview.id,
      mode: interview.mode,
      say: `${feedback} ${question.question}`,
      sayParts: [feedback, question.question],
      sayFeedback: feedback,
      sayQuestion: question.question,
      question: question.question,
      questionOnly: question.question,
      currentQuestionId: question.id,
      section: question.section,
      starred: question.starred,
      verdict: "unintelligible",
      matchedAnswer: null,
      officialAnswers: null,
      answeredQuestionId: question.id,
      canRevise: false,
      finished: false,
      tally: tallyExam(interview.verdicts),
      mastery: masteryTotals(),
      timing: { ...timing, totalUs: elapsedUs(total) },
    };
  }

  const outcome = record(interview, question.id, graded.verdict as Verdict, transcript);
  const step = advance(interview);
  // Show the official answers whenever credit was not full.
  const teach = graded.verdict === "correct" ? null : gradable.answers;
  const common = {
    interviewId: interview.id,
    mode: interview.mode,
    verdict: graded.verdict,
    matchedAnswer: graded.matchedAnswer,
    officialAnswers: teach,
    citationRejected: graded.citationRejected,
    questionMastered: outcome.mastered,
    answeredQuestionId: question.id,
    canRevise: canRevise(interview),
  };

  if (step.done || !step.question) {
    const s = summary();
    const closing = closingFor(outcome.tally);
    const mastered = masteredLine(s.mastered, s.total);
    return {
      ...common,
      say: `${feedback} ${closing} ${mastered}`,
      sayParts: [feedback, closing, mastered],
      sayFeedback: `${feedback} ${closing} ${mastered}`,
      sayQuestion: null,
      question: null,
      questionOnly: null,
      currentQuestionId: null,
      finished: true,
      tally: outcome.tally,
      mastery: masteryTotals(),
      timing: { ...timing, totalUs: elapsedUs(total) },
    };
  }

  return {
    ...common,
    say: `${feedback} ${step.question.question}`,
    sayParts: [feedback, step.question.question],
    sayFeedback: feedback,
    sayQuestion: step.question.question,
    ...questionFields(step),
    finished: false,
    tally: outcome.tally,
    mastery: masteryTotals(),
    timing: { ...timing, totalUs: elapsedUs(total) },
  };
}

export interface OverrideResponse {
  verdict: Verdict;
  questionId: number;
  questionMastered: boolean;
  tally: ExamTally;
  finished: boolean;
  /** Lines to speak because the correction changed the outcome; empty otherwise. */
  sayParts: string[];
  /** Set when the correction reopened a finished exam or ended an open one. */
  next?: TurnResponse;
}

/**
 * Self-grade: "I said it right" (correct) or "Close, but not exact" (risky).
 *
 * Replaces the last recorded `wrong` in place. Usually nothing is spoken; the
 * next question is already on screen. Two exam edge cases change the outcome:
 * the correction reaches twelve (the exam ends as passed) or makes twelve
 * reachable again after the exam had ended (it reopens with the next question).
 */
export function override(interviewId: string, verdict: "correct" | "risky"): OverrideResponse {
  const interview = getInterview(interviewId);
  if (!interview) throw new EngineError("That session is no longer active. Start a new one.", true);
  const out = revise(interview, verdict);
  if (!out) throw new EngineError("There is no answer to correct.");

  const base: OverrideResponse = {
    verdict,
    questionId: out.questionId,
    questionMastered: out.mastered,
    tally: out.tally,
    finished: interview.finished,
    sayParts: [],
  };

  // Reopened: the exam continues with the next planned question.
  if (out.reopened) {
    const step = advance(interview);
    if (step.question) {
      const parts = [CORRECTION_REOPENED_LINE, step.question.question];
      return {
        ...base,
        finished: false,
        sayParts: parts,
        next: {
          interviewId: interview.id,
          mode: interview.mode,
          say: parts.join(" "),
          sayParts: parts,
          sayFeedback: CORRECTION_REOPENED_LINE,
          sayQuestion: step.question.question,
          ...questionFields(step),
          verdict,
          selfGraded: true,
          answeredQuestionId: out.questionId,
          canRevise: false,
          questionMastered: out.mastered,
          finished: false,
          tally: out.tally,
          mastery: masteryTotals(),
        },
      };
    }
  }

  // The correction reached twelve while the next question was already open.
  if (!interview.finished && interview.mode === "exam" && out.tally.passed) {
    finish(interview, "passed");
    const s = summary();
    const parts = [CORRECTION_PASSED_LINE, masteredLine(s.mastered, s.total)];
    return {
      ...base,
      finished: true,
      sayParts: parts,
      next: {
        interviewId: interview.id,
        mode: interview.mode,
        say: parts.join(" "),
        sayParts: parts,
        sayFeedback: parts.join(" "),
        sayQuestion: null,
        question: null,
        questionOnly: null,
        currentQuestionId: null,
        verdict,
        selfGraded: true,
        answeredQuestionId: out.questionId,
        canRevise: false,
        questionMastered: out.mastered,
        finished: true,
        tally: out.tally,
        mastery: masteryTotals(),
      },
    };
  }

  return base;
}

export interface Stats {
  mastered: number;
  total: number;
  confirm: number;
  lapsed: number;
  unseen: number;
  starredMastered: number;
  starredTotal: number;
  attempted: number;
  skipped: number[];
  cells: Array<{ id: number; state: CellState; starred: boolean; section: string; question: string }>;
  sections: ReturnType<typeof statsBySection>;
  weakest: Array<{ id: number; question: string; section: string; attempts: number; streak: number }>;
}

/** The 128-cell status grid and counters (was /api/stats). */
export function getStats(): Stats {
  const bank = poolFor(false);
  const progress = loadProgress();
  const starred = bank.filter((q) => q.starred);

  const cells = bank.map((q) => {
    const r = recordOf(progress, q.id);
    const state: CellState =
      r.streak >= MASTERY_STREAK
        ? "mastered"
        : r.attempts === 0
          ? "unseen"
          : r.streak === MASTERY_STREAK - 1
            ? "confirm"
            : "lapsed";
    return { id: q.id, state, starred: q.starred, section: q.section, question: q.question };
  });

  return {
    mastered: cells.filter((c) => c.state === "mastered").length,
    total: bank.length,
    confirm: cells.filter((c) => c.state === "confirm").length,
    lapsed: cells.filter((c) => c.state === "lapsed").length,
    unseen: cells.filter((c) => c.state === "unseen").length,
    starredMastered: starred.filter((q) => isMastered(recordOf(progress, q.id))).length,
    starredTotal: starred.length,
    attempted: bank.filter((q) => recordOf(progress, q.id).attempts > 0).length,
    skipped: skippedIds(),
    cells,
    sections: statsBySection(bank, progress),
    weakest: weakIds(bank, progress)
      .slice(0, 10)
      .map((id) => {
        const q = bank.find((x) => x.id === id)!;
        const r = recordOf(progress, id);
        return { id, question: q.question, section: q.section, attempts: r.attempts, streak: r.streak };
      }),
  };
}

/**
 * Every line the app can speak from a fixed set, for audio bundling and the
 * bundler's sync test. Dynamic counts (closing lines) are included for the exam,
 * where they are bounded; practice-mode closings fall back to the browser voice.
 */
export function allSpokenLines(): string[] {
  const pool = poolFor(false);
  const starredPool = poolFor(true);
  const resolved = pool.map(withResolvedAnswers);
  const lines = new Set<string>();

  for (const q of pool) lines.add(q.question);
  lines.add("Correct.");
  lines.add("I did not catch that.");
  for (const q of resolved) {
    const first = q.answers[0];
    if (!first) continue;
    lines.add(feedbackFor("risky", q.answers, first));
    lines.add(feedbackFor("wrong", q.answers, first));
  }
  lines.add(greetingFor("exam"));
  lines.add(greetingFor("practice"));
  lines.add(greetingFor("loop", pool.length));
  lines.add(greetingFor("loop", starredPool.length));
  lines.add(ALL_MASTERED_LINE);
  lines.add(CORRECTION_PASSED_LINE);
  lines.add(CORRECTION_REOPENED_LINE);
  lines.add(closingFor({ asked: EXAM_PASS_MARK, correct: EXAM_PASS_MARK, remainingToPass: 0, passed: true, failed: false }));
  // An exam ends as failed the moment a ninth answer is missed (twelve out of reach).
  for (let correct = 0; correct < EXAM_PASS_MARK; correct++) {
    lines.add(closingFor({ asked: correct + 9, correct, remainingToPass: 0, passed: false, failed: true }));
  }
  for (let m = 0; m <= pool.length; m++) lines.add(masteredLine(m, pool.length));
  return [...lines];
}
