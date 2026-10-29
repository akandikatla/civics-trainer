import { describe, expect, it } from "vitest";
import { grade } from "./grader";
import { countRequired, type Question } from "./mastery";
import { getModelState, isModelReady, loadModelGrader } from "./model-runtime";
import { loadQuestions } from "./store";
import { withResolvedAnswers } from "./local-answers";

// This file never loads a working model (vitest isolates module state per file).
const q = (id: number): Question => withResolvedAnswers(loadQuestions().find((x) => x.id === id)!);

describe("before the model is ready, grading falls back to the offline tiers", () => {
  it("uses the offline pipeline while the model has not loaded", async () => {
    expect(isModelReady()).toBe(false);
    const r = await grade(q(61), "tim walls", 1);
    expect(r).toMatchObject({ verdict: "correct", pipeline: "offline", tier: "fuzzy" });
  });

  it("a failed load is reported and grading keeps working offline", async () => {
    const ok = await loadModelGrader({ modelBaseUrl: "/nonexistent/models" });
    expect(ok).toBe(false);
    expect(getModelState().status).toBe("failed");
    expect(getModelState().error).toBeTruthy();
    const r = await grade(q(20), "um Congress has the power to like make rules that everyone has to follow in the country", 1);
    expect(r.pipeline).toBe("offline");
    expect(r.verdict).not.toBe("risky");
    const apple = await grade(q(78), "apple mattocks", countRequired(q(78).question));
    expect(["wrong", "unintelligible"]).toContain(apple.verdict);
  });
});
