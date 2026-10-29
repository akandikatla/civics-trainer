/**
 * Test hook for headless checks, installed only when the page is opened with
 * `?debug=1`. Nothing here runs for normal visitors.
 *
 *   await window.__civicsModelReady()            // true once the model is ready
 *   await window.__civicsGrade(79, "july fourth seventeen seventy six")
 *     -> { verdict, matchedAnswer, tier, pipeline, ms }
 */

import { grade } from "./grader";
import { countRequired } from "./mastery";
import { getModelState, loadModelGrader } from "./model-runtime";
import { questionById } from "./store";
import { withResolvedAnswers } from "./local-answers";

declare global {
  interface Window {
    __civicsGrade?: (questionId: number, transcript: string) => Promise<unknown>;
    __civicsModelReady?: () => Promise<boolean>;
    __civicsModelState?: typeof getModelState;
  }
}

export function installDebugHook() {
  if (typeof window === "undefined") return;
  if (new URLSearchParams(window.location.search).get("debug") !== "1") return;
  window.__civicsModelState = getModelState;
  window.__civicsModelReady = () => loadModelGrader();
  window.__civicsGrade = async (questionId, transcript) => {
    const raw = questionById(questionId);
    if (!raw) throw new Error(`no question ${questionId}`);
    const q = withResolvedAnswers(raw);
    const t0 = performance.now();
    const g = await grade(q, transcript, countRequired(q.question));
    return { verdict: g.verdict, matchedAnswer: g.matchedAnswer, tier: g.tier, pipeline: g.pipeline, ms: +(performance.now() - t0).toFixed(1) };
  };
}
