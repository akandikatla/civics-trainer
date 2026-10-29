/**
 * Grading, on this device: no server, no network.
 *
 * Grading runs as an ordered pipeline of tiers. Each tier either returns a
 * verdict or passes (null) to the next one. There are two pipelines.
 *
 * Model pipeline (once the distilled model has loaded; lib/model-runtime.ts):
 *
 *   1. exact             near-identical to a listed answer (fastPathMatch) -> correct
 *   2. model             lib/model-grader.ts, which follows the decision rule in
 *                        ~/civics-grader-model/REPORT.md: unintelligible rule
 *                        (nothing but filler) -> unintelligible, otherwise the
 *                        cross-encoder with its tuned thresholds and the strict
 *                        number guard -> correct / risky / wrong / unintelligible
 *
 *   The model's own verdict is final. The fuzzy tier is NOT consulted after a
 *   model `wrong`: on ~/civics-grader-model's fresh Claude-labelled test set
 *   (1338 rows, majority of 3) it moved agreement 85.65% -> 85.35% and false
 *   credit 0.58% -> 5.64% (eval/pipelines.ts; README "How grading works"), so it
 *   only runs in the offline pipeline. MODEL_FUZZY_TIERS keeps that variant for
 *   measurement.
 *
 * Offline pipeline (model still loading, or it cannot run on this device):
 *
 *   1. intelligibility   empty or pure filler            -> unintelligible
 *   2. exact             fastPathMatch                   -> correct
 *   3. fuzzy             token + edit distance + phonetic matching (fuzzy.ts) -> correct
 *   default              nothing matched                 -> wrong
 *
 * The offline tiers never emit `risky`; the model can. Either way the applicant
 * can upgrade a `wrong` with the self-grade buttons in the UI.
 *
 * Whatever a tier decides, one rule survives as a final guard: credit needs a
 * receipt. A `correct` or `risky` verdict must cite an answer that passes
 * `citationSatisfies` against the real list, or it is downgraded to `wrong`.
 */

import { citationSatisfies, fastPathMatch, type Question, type Verdict } from "./mastery";
import { findAnswers, isNoise } from "./fuzzy";
import { isModelReady, runModel } from "./model-runtime";
import { elapsedUs, startTimer } from "./timing";

/** A fourth outcome: audio too garbled to grade, so the officer re-asks. */
export type GradeVerdict = Verdict | "unintelligible";

export interface Grade {
  verdict: GradeVerdict;
  matchedAnswer: string | null;
  /** True when a tier claimed credit citing an answer that is not on the list. */
  citationRejected: boolean;
  /** What the tier tried to cite, when the citation was rejected. */
  rejectedCitation?: string | null;
  /** Wall time spent grading, in microseconds. */
  latencyUs: number;
  /** True when the answer was credited by the exact-match tier. */
  fastPath?: boolean;
  /** Which tier decided the verdict. */
  tier?: string;
  /** Match strength from the deciding tier, 0..1, when it has one. */
  score?: number;
  /** Which pipeline graded: the model one, or the offline fallback. */
  pipeline: GradePipeline;
}

export type GradePipeline = "model" | "offline";

export interface GradeInput {
  question: Question;
  transcript: string;
  answersRequired: number;
}

/** What a tier returns when it decides. `latencyUs` and the receipt check are added by `grade()`. */
export interface TierVerdict {
  verdict: GradeVerdict;
  matchedAnswer: string | null;
  score?: number;
  fastPath?: boolean;
  /** Overrides the reported tier name (the model tier reports which rule decided). */
  tier?: string;
  /** Set when a model tier had to fall back to the offline tiers. */
  pipeline?: GradePipeline;
}

export interface GradingTier {
  name: string;
  run(input: GradeInput): TierVerdict | null | Promise<TierVerdict | null>;
}

export const intelligibilityTier: GradingTier = {
  name: "intelligibility",
  run: ({ transcript }) =>
    !transcript.trim() || isNoise(transcript) ? { verdict: "unintelligible", matchedAnswer: null } : null,
};

export const exactTier: GradingTier = {
  name: "exact",
  run: ({ question, transcript, answersRequired }) => {
    const hit = fastPathMatch(transcript, question.answers, answersRequired);
    return hit ? { verdict: "correct", matchedAnswer: hit, score: 1, fastPath: true } : null;
  },
};

export const fuzzyTier: GradingTier = {
  name: "fuzzy",
  run: ({ question, transcript, answersRequired }) => {
    const found = findAnswers(transcript, question.answers, answersRequired);
    return found ? { verdict: "correct", matchedAnswer: found.matched.join("; "), score: found.score } : null;
  },
};

/** The offline pipeline. Insert new tiers before the implicit `wrong` default. */
export const OFFLINE_TIERS: GradingTier[] = [intelligibilityTier, exactTier, fuzzyTier];
/** Kept for callers that predate the model: the offline pipeline. */
export const DEFAULT_TIERS = OFFLINE_TIERS;

/** Run tiers in order; the first verdict wins, `wrong` when none decides. */
async function runTiers(tiers: GradingTier[], input: GradeInput): Promise<{ decided: TierVerdict; tierName: string }> {
  for (const tier of tiers) {
    const result = await tier.run(input);
    if (result) return { decided: result, tierName: result.tier ?? tier.name };
  }
  return { decided: { verdict: "wrong", matchedAnswer: null }, tierName: "default" };
}

const MODEL_TIER_NAMES = { "fast-path": "exact", "unintelligible-rule": "unintelligible", model: "model" } as const;

/**
 * The distilled model, with REPORT.md's decision rule (fast path, unintelligible
 * rule, model + number guard) inside lib/model-grader.ts. Its verdict is final,
 * including `wrong`. If the model cannot run, the offline tiers grade instead.
 */
export const modelTier: GradingTier = {
  name: "model",
  run: async (input) => {
    const { question, transcript, answersRequired } = input;
    const g = await runModel({ question: question.question, answers: question.answers }, transcript, answersRequired);
    if (!g) {
      const { decided, tierName } = await runTiers(OFFLINE_TIERS, input);
      return { ...decided, tier: tierName, pipeline: "offline" };
    }
    const top = g.scores.length ? Math.max(...g.scores.map((s) => s.correct)) : undefined;
    return {
      verdict: g.verdict,
      matchedAnswer: g.matchedAnswer,
      score: g.decidedBy === "fast-path" ? 1 : top,
      fastPath: g.decidedBy === "fast-path" || undefined,
      tier: MODEL_TIER_NAMES[g.decidedBy],
    };
  },
};

/**
 * Same as modelTier, but a model `wrong` is passed on to the fuzzy matcher.
 * Not shipped (it adds false credit); kept so eval/pipelines.ts can measure it.
 */
export const modelThenFuzzyTier: GradingTier = {
  name: "model",
  run: async (input) => {
    const r = await modelTier.run(input);
    if (r && r.verdict === "wrong" && r.pipeline !== "offline") {
      const f = await fuzzyTier.run(input);
      return f ? { ...f, tier: "fuzzy" } : r;
    }
    return r;
  },
};

/** The model pipeline. */
export const MODEL_TIERS: GradingTier[] = [exactTier, modelTier];
/** Model pipeline with the fuzzy tier as a fallback after a model `wrong` (evaluation only). */
export const MODEL_FUZZY_TIERS: GradingTier[] = [exactTier, modelThenFuzzyTier];

/** The pipeline `grade()` uses when none is passed: the model once it is ready. */
export const activeTiers = (): GradingTier[] => (isModelReady() ? MODEL_TIERS : OFFLINE_TIERS);

export async function grade(
  question: Question,
  transcript: string,
  answersRequired: number,
  tiers: GradingTier[] = activeTiers(),
): Promise<Grade> {
  const timer = startTimer();
  const input: GradeInput = { question, transcript, answersRequired };
  const usesModel = tiers.some((t) => t === modelTier || t === modelThenFuzzyTier);

  const { decided, tierName } = await runTiers(tiers, input);
  const pipeline: GradePipeline = usesModel && decided.pipeline !== "offline" ? "model" : "offline";

  // Receipt rule: credit must cite a real listed answer, whatever tier awarded it.
  if (
    (decided.verdict === "correct" || decided.verdict === "risky") &&
    !citationSatisfies(decided.matchedAnswer ?? "", question.answers, 1)
  ) {
    return {
      verdict: "wrong",
      matchedAnswer: null,
      citationRejected: true,
      rejectedCitation: decided.matchedAnswer,
      latencyUs: elapsedUs(timer),
      tier: tierName,
      pipeline,
    };
  }

  return {
    verdict: decided.verdict,
    matchedAnswer: decided.verdict === "correct" || decided.verdict === "risky" ? decided.matchedAnswer : null,
    citationRejected: false,
    latencyUs: elapsedUs(timer),
    fastPath: decided.fastPath,
    tier: tierName,
    score: decided.score,
    pipeline,
  };
}

/**
 * The spoken feedback line, composed deterministically from the verdict.
 *
 * The set of possible lines is finite, so every one can be pre-recorded and
 * bundled as audio (see scripts/bundle-audio.mjs).
 */
export function feedbackFor(verdict: GradeVerdict, official: string[], matchedAnswer: string | null): string {
  const teach = matchedAnswer ?? official[0] ?? "";
  switch (verdict) {
    case "correct":
      return "Correct.";
    case "risky":
      return `That would likely be accepted. The official wording is ${teach}.`;
    case "wrong":
      return `That is not correct. One accepted answer is ${teach}.`;
    default:
      return "I did not catch that.";
  }
}

/** Every feedback line the app can ever speak, for audio bundling. Pass resolved questions. */
export function allFeedbackLines(questions: Array<{ answers: string[] }>): string[] {
  const lines = new Set<string>(["Correct.", "I did not catch that."]);
  for (const q of questions) {
    const first = q.answers[0];
    if (!first) continue;
    lines.add(feedbackFor("risky", q.answers, first));
    lines.add(feedbackFor("wrong", q.answers, first));
  }
  return [...lines];
}
