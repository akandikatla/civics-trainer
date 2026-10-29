import { describe, it, expect } from "vitest";
import { applyVerdict, emptyProgress, isMastered, recordOf, reviseLastVerdict, type Progress } from "./mastery";

/** Strip the date stamp so two progress objects built on different days compare equal. */
const undated = (p: Progress) => ({
  ...p,
  q: Object.fromEntries(Object.entries(p.q).map(([k, r]) => [k, { ...r, last: undefined }])),
});

describe("reviseLastVerdict: self-grade override", () => {
  it("replaces a wrong with correct as if correct had been recorded", () => {
    let p = applyVerdict(emptyProgress(), 7, "correct");
    const prior = recordOf(p, 7);
    const wrong = applyVerdict(p, 7, "wrong");
    const revised = reviseLastVerdict(wrong, 7, "correct", prior)!;
    expect(undated(revised)).toEqual(undated(applyVerdict(p, 7, "correct")));
    expect(isMastered(recordOf(revised, 7))).toBe(true);
  });

  it("does not double count attempts, steps or log entries", () => {
    const p = applyVerdict(emptyProgress(), 3, "wrong");
    const revised = reviseLastVerdict(p, 3, "correct", null)!;
    expect(revised.step).toBe(1);
    expect(revised.log).toHaveLength(1);
    expect(revised.log[0]).toMatchObject({ id: 3, verdict: "correct", ok: true });
    expect(recordOf(revised, 3)).toMatchObject({ attempts: 1, correct: 1, streak: 1 });
  });

  it("re-records as risky: holds the streak instead of resetting it", () => {
    let p = applyVerdict(emptyProgress(), 5, "correct");
    const prior = recordOf(p, 5);
    p = applyVerdict(p, 5, "wrong");
    expect(recordOf(p, 5).streak).toBe(0);
    const revised = reviseLastVerdict(p, 5, "risky", prior)!;
    expect(recordOf(revised, 5)).toMatchObject({ attempts: 2, correct: 1, streak: 1 });
    expect(revised.log.map((e) => e.verdict)).toEqual(["correct", "risky"]);
  });

  it("removes a first-ever attempt cleanly when prior is null", () => {
    const p = applyVerdict(applyVerdict(emptyProgress(), 1, "correct"), 2, "wrong");
    const revised = reviseLastVerdict(p, 2, "correct", null)!;
    expect(recordOf(revised, 1)).toMatchObject({ attempts: 1, correct: 1 });
    expect(recordOf(revised, 2)).toMatchObject({ attempts: 1, correct: 1, streak: 1 });
  });

  it("refuses when something else was recorded since", () => {
    const p = applyVerdict(applyVerdict(emptyProgress(), 1, "wrong"), 2, "correct");
    expect(reviseLastVerdict(p, 1, "correct", null)).toBeNull();
    expect(reviseLastVerdict(emptyProgress(), 1, "correct", null)).toBeNull();
  });

  it("never mutates its input", () => {
    const p = applyVerdict(emptyProgress(), 9, "wrong");
    const snapshot = JSON.stringify(p);
    reviseLastVerdict(p, 9, "correct", null);
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
