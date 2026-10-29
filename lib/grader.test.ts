import { resolve } from "node:path";
import { beforeAll, describe, it, expect } from "vitest";
import { ALL_CASES, HARD_CASES } from "../eval/cases";
import {
  DEFAULT_TIERS,
  MODEL_TIERS,
  OFFLINE_TIERS,
  allFeedbackLines,
  feedbackFor,
  grade,
  type GradingTier,
} from "./grader";
import { getModelState, loadModelGrader } from "./model-runtime";
import { answerVariants, levenshtein, phoneticKey, tokenSimilarity, tokenize } from "./fuzzy";
import { countRequired, isPlaceholderAnswer, type Question } from "./mastery";
import { loadQuestions } from "./store";
import { isGradeable, withResolvedAnswers } from "./local-answers";

/** Share of multi-item list answers the model must credit. Measured: 55/62 (88.7%); the 7 misses are false rejections. */
const MULTI_FLOOR = 0.85;

const bank = loadQuestions();
const resolved = (id: number): Question => {
  const q = bank.find((x) => x.id === id);
  if (!q) throw new Error(`question ${id} missing`);
  return withResolvedAnswers(q);
};

// The real model, from the same folder the site serves, on onnxruntime-node.
beforeAll(async () => {
  const ok = await loadModelGrader({ modelBaseUrl: resolve(__dirname, "..", "public", "models") });
  expect(ok, getModelState().error).toBe(true);
}, 120_000);

function expectReceipt(q: Question, verdict: string, matched: string | null) {
  if (verdict === "correct" || verdict === "risky") {
    expect(matched, "credit must cite an official answer").toBeTruthy();
    for (const part of matched!.split("; ")) expect(q.answers).toContain(part);
  }
}

describe("grading cases, model pipeline (eval/cases.ts `expected`)", () => {
  for (const c of ALL_CASES) {
    it(`Q${c.questionId} "${c.transcript.slice(0, 48)}" -> ${c.expected.join("|")} (${c.why})`, async () => {
      const q = resolved(c.questionId);
      const r = await grade(q, c.transcript, countRequired(q.question)); // default = model once loaded
      expect(r.pipeline).toBe("model");
      expect(c.expected, `got ${r.verdict} matched=${r.matchedAnswer} tier=${r.tier}`).toContain(r.verdict);
      expectReceipt(q, r.verdict, r.matchedAnswer);
    });
  }
});

describe("grading cases, offline fallback (eval/cases.ts `offline` ?? `expected`)", () => {
  for (const c of ALL_CASES) {
    const want = c.offline ?? c.expected;
    it(`Q${c.questionId} "${c.transcript.slice(0, 48)}" -> ${want.join("|")}`, async () => {
      const q = resolved(c.questionId);
      const r = await grade(q, c.transcript, countRequired(q.question), OFFLINE_TIERS);
      expect(r.pipeline).toBe("offline");
      expect(want, `got ${r.verdict} matched=${r.matchedAnswer}`).toContain(r.verdict);
      // Offline tiers never award risky on their own.
      expect(r.verdict).not.toBe("risky");
      expectReceipt(q, r.verdict, r.matchedAnswer);
    });
  }
});

describe("hard cases hold in both pipelines", () => {
  for (const c of HARD_CASES) {
    it(`Q${c.questionId} "${c.transcript}" -> ${c.expected.join("|")}`, async () => {
      const q = resolved(c.questionId);
      for (const tiers of [MODEL_TIERS, OFFLINE_TIERS]) {
        const r = await grade(q, c.transcript, countRequired(q.question), tiers);
        expect(c.expected, `${tiers === MODEL_TIERS ? "model" : "offline"}: got ${r.verdict}`).toContain(r.verdict);
      }
    });
  }

  it('"apple mattocks" is never credited, for any question', async () => {
    const credited: string[] = [];
    for (const raw of bank.filter(isGradeable)) {
      const q = withResolvedAnswers(raw);
      const r = await grade(q, "apple mattocks", countRequired(q.question), MODEL_TIERS);
      if (r.verdict === "correct" || r.verdict === "risky") credited.push(`Q${q.id} -> ${r.verdict} ${r.matchedAnswer}`);
    }
    expect(credited, credited.join("\n")).toEqual([]);
  });
});

describe("the whole bank grades its own answers (offline pipeline)", () => {
  it("every listed answer is graded correct for its own question", async () => {
    const failures: string[] = [];
    for (const raw of bank.filter(isGradeable)) {
      const q = withResolvedAnswers(raw);
      const need = countRequired(q.question);
      const answers = q.answers.filter((a) => !isPlaceholderAnswer(a));
      if (need === 1) {
        for (const a of answers) {
          const r = await grade(q, a, 1, OFFLINE_TIERS);
          if (r.verdict !== "correct") failures.push(`Q${q.id}: "${a}" -> ${r.verdict}`);
        }
      } else {
        // Every consecutive window of `need` answers, spoken as a list.
        for (let i = 0; i + need <= answers.length; i++) {
          const said = answers.slice(i, i + need).join(", ");
          const r = await grade(q, said, need, OFFLINE_TIERS);
          if (r.verdict !== "correct") failures.push(`Q${q.id}: "${said}" -> ${r.verdict}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("multi-item questions reject one item fewer than required", async () => {
    const failures: string[] = [];
    for (const raw of bank) {
      const q = withResolvedAnswers(raw);
      const need = countRequired(q.question);
      if (need < 2) continue;
      const said = q.answers.slice(0, need - 1).join(", ");
      const r = await grade(q, said, need, OFFLINE_TIERS);
      if (r.verdict === "correct") failures.push(`Q${q.id}: "${said}"`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("the whole bank, model pipeline", () => {
  it("every single listed answer, said verbatim, is credited", async () => {
    const failures: string[] = [];
    for (const raw of bank.filter(isGradeable)) {
      const q = withResolvedAnswers(raw);
      if (countRequired(q.question) !== 1) continue;
      for (const a of q.answers.filter((x) => !isPlaceholderAnswer(x))) {
        const r = await grade(q, a, 1, MODEL_TIERS);
        if (r.verdict !== "correct") failures.push(`Q${q.id}: "${a}" -> ${r.verdict}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("multi-item questions: listed answers in a list are credited at least MULTI_FLOOR of the time", async () => {
    let total = 0;
    const failures: string[] = [];
    for (const raw of bank.filter(isGradeable)) {
      const q = withResolvedAnswers(raw);
      const need = countRequired(q.question);
      if (need === 1) continue;
      const answers = q.answers.filter((a) => !isPlaceholderAnswer(a));
      for (let i = 0; i + need <= answers.length; i++) {
        const said = answers.slice(i, i + need).join(", ");
        const r = await grade(q, said, need, MODEL_TIERS);
        total += 1;
        if (r.verdict !== "correct" && r.verdict !== "risky") failures.push(`Q${q.id}: "${said}" -> ${r.verdict}`);
      }
    }
    // The model is strict; these are false rejections the self-grade buttons cover.
    expect(1 - failures.length / total, failures.join("\n")).toBeGreaterThanOrEqual(MULTI_FLOOR);
  }, 60_000);

  it("multi-item questions never credit one item fewer than required", async () => {
    const failures: string[] = [];
    for (const raw of bank) {
      const q = withResolvedAnswers(raw);
      const need = countRequired(q.question);
      if (need < 2) continue;
      const said = q.answers.slice(0, need - 1).join(", ");
      const r = await grade(q, said, need, MODEL_TIERS);
      if (r.verdict === "correct" || r.verdict === "risky") failures.push(`Q${q.id}: "${said}" -> ${r.verdict}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("pipeline", () => {
  it("is async and reports the deciding tier", async () => {
    const q = resolved(2);
    const pending = grade(q, "the constitution", 1);
    expect(pending).toBeInstanceOf(Promise);
    const r = await pending;
    expect(r.verdict).toBe("correct");
    expect(["exact", "model"]).toContain(r.tier);
    expect(r.pipeline).toBe("model");
    expect(r.latencyUs).toBeGreaterThanOrEqual(0);
  });

  it("reports which rule inside the model pipeline decided", async () => {
    expect((await grade(resolved(2), "uh, uh... hmm", 1)).tier).toBe("unintelligible");
    expect((await grade(resolved(22), "six years", 1)).tier).toBe("exact");
    expect((await grade(resolved(22), "four years", 1)).tier).toBe("model");
  });

  it("the model can award risky, with a listed citation", async () => {
    const r = await grade(resolved(20), "um Congress has the power to like make rules that everyone has to follow in the country", 1);
    expect(r).toMatchObject({ verdict: "risky", matchedAnswer: "Writes laws", tier: "model", pipeline: "model" });
  });

  it("falls through to wrong when no tier decides", async () => {
    const r = await grade(resolved(2), "something else entirely", 1, []);
    expect(r).toMatchObject({ verdict: "wrong", matchedAnswer: null, citationRejected: false, tier: "default" });
  });

  it("downgrades credit whose citation is not on the list (receipt rule)", async () => {
    const liar: GradingTier = { name: "liar", run: () => ({ verdict: "correct", matchedAnswer: "Articles of Confederation" }) };
    const r = await grade(resolved(2), "anything", 1, [liar]);
    expect(r.verdict).toBe("wrong");
    expect(r.citationRejected).toBe(true);
    expect(r.rejectedCitation).toBe("Articles of Confederation");
  });

  it("lets a future tier award risky with a valid citation", async () => {
    const future: GradingTier = { name: "knn", run: async () => ({ verdict: "risky", matchedAnswer: "Explains laws" }) };
    const r = await grade(resolved(51), "interpret the law", 1, [...DEFAULT_TIERS, future]);
    expect(r).toMatchObject({ verdict: "risky", matchedAnswer: "Explains laws", tier: "knn" });
  });

  it("joins multi-item credit with '; ' (offline)", async () => {
    const q = resolved(126);
    const r = await grade(q, "Labor Day, Christmas and Thanksgiving", 3, OFFLINE_TIERS);
    expect(r.matchedAnswer).toBe("Labor Day; Thanksgiving Day; Christmas Day");
  });

  it("joins multi-item credit with '; ' (model, top-scoring listed answers)", async () => {
    const q = resolved(126);
    const r = await grade(q, "labor day christmas thanksgiving", 3);
    expect(r.verdict).toBe("correct");
    expect(r.matchedAnswer!.split("; ").sort()).toEqual(["Christmas Day", "Labor Day", "Thanksgiving Day"]);
  });
});

describe("fuzzy building blocks", () => {
  it("normalizes filler, numbers and abbreviations", () => {
    expect(tokenize("Um, I think it's the U.S. Constitution")).toEqual(["us", "constitution"]);
    expect(tokenize("four hundred thirty-five")).toEqual(["435"]);
    expect(tokenize("seventeen seventy six")).toEqual(["1776"]);
    expect(tokenize("the twenty second amendment")).toEqual(["22", "amendment"]);
    expect(tokenize("St. Paul")).toEqual(["saint", "paul"]);
    expect(tokenize("World War II")).toEqual(["world", "war", "2"]);
  });

  it("expands USCIS parentheses and slashes", () => {
    expect(answerVariants("(Thomas) Jefferson")).toEqual(expect.arrayContaining(["Thomas Jefferson", "Jefferson"]));
    expect(answerVariants("Secretary of War (Defense)")).toContain("Secretary of Defense");
    expect(answerVariants("Doubled the size of the United States (Louisiana Purchase)")).toContain("Louisiana Purchase");
    expect(answerVariants("Equal representation (for small states)")).not.toContain("for small states");
    expect(answerVariants("(Battle of) Antietam/Sharpsburg")).toEqual(expect.arrayContaining(["Antietam", "Sharpsburg"]));
  });

  it("phonetic keys collapse sound-alikes", () => {
    expect(phoneticKey("Walz")).toBe(phoneticKey("walls"));
    expect(phoneticKey("Klobuchar")).toBe(phoneticKey("globechar"));
    expect(phoneticKey("Jefferson")).not.toBe(phoneticKey("mattocks"));
  });

  it("token similarity is exact-only for digits and short words", () => {
    expect(tokenSimilarity("6", "5")).toBe(0);
    expect(tokenSimilarity("law", "low")).toBe(0);
    expect(tokenSimilarity("jefferson", "jeffersen")).toBeGreaterThan(0.85);
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("feedback lines", () => {
  it("composes deterministic lines", () => {
    expect(feedbackFor("correct", ["X"], null)).toBe("Correct.");
    expect(feedbackFor("wrong", ["Saint Paul", "St. Paul"], null)).toBe("That is not correct. One accepted answer is Saint Paul.");
  });

  it("includes the Minnesota answers once questions are resolved", () => {
    const lines = allFeedbackLines(bank.map(withResolvedAnswers));
    expect(lines).toContain("That is not correct. One accepted answer is Amy Klobuchar.");
    expect(lines).toContain("That is not correct. One accepted answer is Tim Walz.");
    expect(lines).toContain("That is not correct. One accepted answer is Saint Paul.");
  });
});
