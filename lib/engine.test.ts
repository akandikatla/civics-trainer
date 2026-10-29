import { beforeEach, describe, expect, it } from "vitest";
import { answer, getStats, override, startInterview, type TurnResponse } from "./engine";
import { clearInterviews } from "./interview";
import { loadProgress, loadSessions, questionById, resetProgress } from "./store";
import { withResolvedAnswers } from "./local-answers";
import { countRequired, recordOf } from "./mastery";

/** A transcript the grader will credit for the open question. */
function rightAnswer(turn: TurnResponse): string {
  const q = withResolvedAnswers(questionById(turn.currentQuestionId!)!);
  return q.answers.slice(0, countRequired(q.question)).join(", ");
}
const WRONG = "purple elephant banana";

beforeEach(() => {
  resetProgress();
  clearInterviews();
});

describe("engine (in-browser interview)", () => {
  it("starts with a greeting then the question, as separate spoken parts", () => {
    const t = startInterview("exam");
    expect(t.sayParts).toHaveLength(2);
    expect(t.sayParts[0]).toMatch(/civics portion/);
    expect(t.sayParts[1]).toBe(t.questionOnly);
    expect(getStats().skipped).toEqual([]); // every Minnesota answer is filled in
    expect(getStats().total).toBe(128);
  });

  it("records a wrong answer and offers the override", async () => {
    const t = startInterview("loop");
    const r = await answer(t.interviewId, WRONG);
    expect(r.verdict).toBe("wrong");
    expect(r.canRevise).toBe(true);
    expect(r.sayParts[0]).toMatch(/^That is not correct\./);
  });

  it("'I said it right' replaces the verdict without double counting", async () => {
    const t = startInterview("loop");
    const qid = t.currentQuestionId!;
    await answer(t.interviewId, WRONG);
    const o = override(t.interviewId, "correct");
    expect(o.sayParts).toEqual([]);
    const p = loadProgress();
    expect(p.step).toBe(1);
    expect(p.log).toEqual([expect.objectContaining({ id: qid, verdict: "correct", ok: true })]);
    expect(recordOf(p, qid)).toMatchObject({ attempts: 1, correct: 1, streak: 1 });
    expect(o.tally).toMatchObject({ asked: 1, correct: 1 });
    expect(() => override(t.interviewId, "correct")).toThrow(/no answer to correct/);
  });

  it("'Close, but not exact' records risky: counts on the exam, holds the streak", async () => {
    const t = startInterview("exam");
    const qid = t.currentQuestionId!;
    await answer(t.interviewId, WRONG);
    const o = override(t.interviewId, "risky");
    expect(o.tally.correct).toBe(1);
    expect(recordOf(loadProgress(), qid)).toMatchObject({ attempts: 1, correct: 0, streak: 0 });
    expect(loadProgress().log.at(-1)?.verdict).toBe("risky");
  });

  it("cannot override once another answer has been recorded", async () => {
    let t = startInterview("loop");
    t = await answer(t.interviewId, WRONG);
    t = await answer(t.interviewId, rightAnswer(t));
    expect(t.verdict).toBe("correct");
    expect(t.canRevise).toBe(false);
    expect(() => override(t.interviewId, "correct")).toThrow();
  });

  it("unintelligible re-asks without recording anything", async () => {
    const t = startInterview("loop");
    const r = await answer(t.interviewId, "um uh");
    expect(r.verdict).toBe("unintelligible");
    expect(r.currentQuestionId).toBe(t.currentQuestionId);
    expect(loadProgress().step).toBe(0);
  });

  it("reopens a failed exam when the correction makes twelve reachable", async () => {
    let t = startInterview("exam");
    for (let i = 0; i < 9; i++) t = await answer(t.interviewId, WRONG);
    expect(t.finished).toBe(true);
    expect(t.sayParts.some((p) => /That is the end\. You answered 0 of 9/.test(p))).toBe(true);
    expect(loadSessions()).toHaveLength(1);

    const o = override(t.interviewId, "correct");
    expect(o.finished).toBe(false);
    expect(o.next?.currentQuestionId).toBeTruthy();
    expect(o.sayParts[0]).toBe("With that correction, the interview continues.");
    expect(loadSessions()).toHaveLength(0); // withdrawn; written again when it really ends

    const next = await answer(t.interviewId, WRONG);
    expect(next.finished).toBe(true);
    expect(loadSessions()).toHaveLength(1);
    expect(loadSessions()[0]).toMatchObject({ asked: 10, correct: 1 });
    expect(loadSessions()[0].results[8]).toMatchObject({ verdict: "correct", selfGraded: true });
  });

  it("ends the exam as passed when the correction is the twelfth right answer", async () => {
    let t = startInterview("exam");
    for (let i = 0; i < 11; i++) t = await answer(t.interviewId, rightAnswer(t));
    t = await answer(t.interviewId, WRONG);
    expect(t.finished).toBe(false);
    const o = override(t.interviewId, "correct");
    expect(o.finished).toBe(true);
    expect(o.tally).toMatchObject({ correct: 12, passed: true });
    expect(o.sayParts[0]).toBe("With that correction, you have passed the civics test.");
    expect(loadSessions().at(-1)).toMatchObject({ passed: true, correct: 12, asked: 12 });
  });

  it("reset progress clears storage", async () => {
    const t = startInterview("loop");
    await answer(t.interviewId, rightAnswer(t));
    expect(loadProgress().step).toBe(1);
    resetProgress();
    expect(loadProgress().step).toBe(0);
    expect(getStats().unseen).toBe(128);
  });
});
