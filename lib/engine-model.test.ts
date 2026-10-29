import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answer, startInterview } from "./engine";
import { clearInterviews, getInterview } from "./interview";
import { loadProgress, resetProgress } from "./store";
import { recordOf } from "./mastery";
import { loadModelGrader } from "./model-runtime";

// The engine with the real model loaded: `risky` now reaches the interview.
const RISKY = "um Congress has the power to like make rules that everyone has to follow in the country"; // Q20

beforeAll(async () => {
  expect(await loadModelGrader({ modelBaseUrl: resolve(__dirname, "..", "public", "models") })).toBe(true);
}, 120_000);

beforeEach(() => {
  resetProgress();
  clearInterviews();
});

/** Start a session and make Q20 the open question. */
function openQ20(mode: "exam" | "loop") {
  const t = startInterview(mode);
  getInterview(t.interviewId)!.currentQuestionId = 20;
  return t.interviewId;
}

describe("engine with the model grader", () => {
  it("a model `risky` counts on the exam but does not advance the streak", async () => {
    const id = openQ20("exam");
    const r = await answer(id, RISKY);
    expect(r.verdict).toBe("risky");
    expect(r.matchedAnswer).toBe("Writes laws");
    expect(r.timing?.pipeline).toBe("model");
    expect(r.tally).toMatchObject({ asked: 1, correct: 1 }); // counts toward the 12
    expect(r.officialAnswers).toContain("Writes laws"); // teaching shown for non-full credit
    expect(r.canRevise).toBe(false); // override buttons are for a `wrong`
    expect(r.questionMastered).toBe(false);
    expect(r.sayParts[0]).toBe("That would likely be accepted. The official wording is Writes laws.");
    const rec = recordOf(loadProgress(), 20);
    expect(rec).toMatchObject({ attempts: 1, correct: 0, streak: 0 });
  });

  it("a model `wrong` still offers the override buttons", async () => {
    const id = openQ20("loop");
    const r = await answer(id, "the president signs them");
    expect(r.verdict).toBe("wrong");
    expect(r.canRevise).toBe(true);
    expect(r.timing?.pipeline).toBe("model");
  });

  it("a model `unintelligible` re-asks without recording an attempt", async () => {
    const id = openQ20("loop");
    const r = await answer(id, "um uh");
    expect(r.verdict).toBe("unintelligible");
    expect(r.currentQuestionId).toBe(20);
    expect(recordOf(loadProgress(), 20).attempts).toBe(0);
  });
});
