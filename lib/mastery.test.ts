import { describe, it, expect } from "vitest";
import {
  MASTERY_STREAK,
  EXAM_LENGTH,
  EXAM_PASS_MARK,
  emptyProgress,
  recordOf,
  applyVerdict,
  isMastered,
  pendingIds,
  nextQuestionId,
  examPlan,
  tallyExam,
  statsBySection,
  weakIds,
  matchesOfficial,
  fastPathMatch,
  citationSatisfies,
  dueLapsedIds,
  dueConfirmIds,
  countRequired,
  isPlaceholderAnswer,
  needsLocalAnswers,
} from "./mastery";
import type { Progress, Question } from "./mastery";

/** Minimal fake bank: 4 government, 3 history, 2 symbols. */
const BANK: Question[] = [
  { id: 1, part: "American Government", section: "Principles", question: "g1", answers: ["a"], starred: false },
  { id: 2, part: "American Government", section: "Principles", question: "g2", answers: ["a"], starred: true },
  { id: 3, part: "American Government", section: "System", question: "g3", answers: ["a"], starred: false },
  { id: 4, part: "American Government", section: "System", question: "g4", answers: ["a"], starred: false },
  { id: 5, part: "American History", section: "Colonial", question: "h1", answers: ["a"], starred: false },
  { id: 6, part: "American History", section: "Colonial", question: "h2", answers: ["a"], starred: true },
  { id: 7, part: "American History", section: "1800s", question: "h3", answers: ["a"], starred: false },
  { id: 8, part: "Symbols And Holidays", section: "Symbols", question: "s1", answers: ["a"], starred: false },
  { id: 9, part: "Symbols And Holidays", section: "Holidays", question: "s2", answers: ["a"], starred: false },
];

const ids = BANK.map((q) => q.id);

/** Deterministic "random": always picks the first candidate. */
const firstPick = <T>(xs: T[]): T => xs[0];

describe("applyVerdict: mastery streak rules", () => {
  it("advances the streak on correct", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    expect(recordOf(p, 1).streak).toBe(1);
    expect(recordOf(p, 1).correct).toBe(1);
    expect(recordOf(p, 1).attempts).toBe(1);
  });

  it("masters a question after two consecutive correct answers", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    expect(isMastered(recordOf(p, 1))).toBe(false);
    p = applyVerdict(p, 1, "correct");
    expect(isMastered(recordOf(p, 1))).toBe(true);
    expect(MASTERY_STREAK).toBe(2);
  });

  it("resets the streak to zero on wrong", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    p = applyVerdict(p, 1, "wrong");
    expect(recordOf(p, 1).streak).toBe(0);
    expect(isMastered(recordOf(p, 1))).toBe(false);
  });

  it("holds the streak on risky: neither advances nor resets", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    expect(recordOf(p, 1).streak).toBe(1);
    p = applyVerdict(p, 1, "risky");
    expect(recordOf(p, 1).streak).toBe(1);
    expect(isMastered(recordOf(p, 1))).toBe(false);
  });

  it("never masters a question via risky answers alone", () => {
    let p = emptyProgress();
    for (let i = 0; i < 10; i++) p = applyVerdict(p, 1, "risky");
    expect(isMastered(recordOf(p, 1))).toBe(false);
    expect(recordOf(p, 1).attempts).toBe(10);
  });

  it("does not count risky toward the official correct tally", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "risky");
    expect(recordOf(p, 1).correct).toBe(0);
    expect(recordOf(p, 1).attempts).toBe(1);
  });

  it("loses mastery when a mastered question is later answered wrong", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    p = applyVerdict(p, 1, "correct");
    expect(isMastered(recordOf(p, 1))).toBe(true);
    p = applyVerdict(p, 1, "wrong");
    expect(isMastered(recordOf(p, 1))).toBe(false);
  });

  it("is immutable: does not mutate the input progress", () => {
    const p0 = emptyProgress();
    const p1 = applyVerdict(p0, 1, "correct");
    expect(p0.step).toBe(0);
    expect(p1.step).toBe(1);
    expect(p0.q["1"]).toBeUndefined();
  });

  it("increments the global step on every verdict", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    p = applyVerdict(p, 2, "wrong");
    p = applyVerdict(p, 3, "risky");
    expect(p.step).toBe(3);
  });

  it("appends a log entry carrying the verdict and a python-compatible ok flag", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 7, "risky");
    expect(p.log).toHaveLength(1);
    expect(p.log[0]).toMatchObject({ step: 1, id: 7, verdict: "risky", ok: false });
    p = applyVerdict(p, 7, "correct");
    expect(p.log[1]).toMatchObject({ id: 7, verdict: "correct", ok: true });
  });
});

describe("scheduling: wrong answers return soonest, mastered ones leave the queue", () => {
  it("schedules wrong sooner than risky, and risky sooner than a first correct", () => {
    const base = emptyProgress();
    const dueAfter = (v: "correct" | "risky" | "wrong") => {
      const p = applyVerdict(base, 1, v);
      return recordOf(p, 1).due - p.step;
    };
    expect(dueAfter("wrong")).toBeLessThan(dueAfter("risky"));
    expect(dueAfter("risky")).toBeLessThan(dueAfter("correct"));
  });

  it("drops a mastered question out of the pending pool", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    expect(pendingIds(p, ids)).toContain(1);
    p = applyVerdict(p, 1, "correct");
    expect(pendingIds(p, ids)).not.toContain(1);
  });

  it("treats unseen questions as due immediately", () => {
    const p = emptyProgress();
    expect(pendingIds(p, ids)).toEqual(ids);
  });

  it("picks the question with the lowest due step", () => {
    let p = emptyProgress();
    // Answer every question correctly once so all are seen and scheduled.
    for (const id of ids) p = applyVerdict(p, id, "correct");
    // Now miss question 5; it should jump the queue.
    p = applyVerdict(p, 5, "wrong");
    expect(nextQuestionId(p, ids, firstPick)).toBe(5);
  });

  it("returns null when every question in the pool is mastered", () => {
    let p = emptyProgress();
    for (const id of ids) {
      p = applyVerdict(p, id, "correct");
      p = applyVerdict(p, id, "correct");
    }
    expect(nextQuestionId(p, ids, firstPick)).toBeNull();
  });

  it("restricts practice to a starred-only pool when asked", () => {
    const starred = BANK.filter((q) => q.starred).map((q) => q.id);
    const p = emptyProgress();
    expect(starred).toEqual([2, 6]);
    expect(nextQuestionId(p, starred, firstPick)).toBe(2);
  });
});

describe("examPlan: mirrors the real bank's section distribution", () => {
  it("returns EXAM_LENGTH questions with no repeats", () => {
    const plan = examPlan(BANK, () => 0.5, 9);
    expect(plan).toHaveLength(9);
    expect(new Set(plan).size).toBe(9);
  });

  it("weights sections by their share of the bank", () => {
    // 9-question plan over a 4/3/2 bank should reproduce 4/3/2.
    const plan = examPlan(BANK, () => 0.5, 9);
    const partOf = (id: number) => BANK.find((q) => q.id === id)!.part;
    const counts = plan.reduce<Record<string, number>>((acc, id) => {
      acc[partOf(id)] = (acc[partOf(id)] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["American Government"]).toBe(4);
    expect(counts["American History"]).toBe(3);
    expect(counts["Symbols And Holidays"]).toBe(2);
  });

  it("never returns more questions than the bank holds", () => {
    expect(examPlan(BANK, () => 0.5, 20)).toHaveLength(9);
  });

  it("defaults to the real exam length of 20", () => {
    expect(EXAM_LENGTH).toBe(20);
    expect(EXAM_PASS_MARK).toBe(12);
  });
});

describe("tallyExam: USCIS pass/fail arithmetic", () => {
  const v = (n: number, verdict: "correct" | "risky" | "wrong") =>
    Array.from({ length: n }, () => verdict);

  it("counts both correct and risky toward the exam score", () => {
    const t = tallyExam([...v(6, "correct"), ...v(6, "risky")]);
    expect(t.correct).toBe(12);
    expect(t.passed).toBe(true);
  });

  it("does not pass at 11 correct", () => {
    const t = tallyExam(v(11, "correct"));
    expect(t.passed).toBe(false);
    expect(t.remainingToPass).toBe(1);
  });

  it("passes as soon as the 12th correct answer lands", () => {
    const t = tallyExam(v(12, "correct"));
    expect(t.passed).toBe(true);
    expect(t.asked).toBe(12);
    expect(t.remainingToPass).toBe(0);
  });

  it("fails once 9 misses make 12 unreachable", () => {
    const t = tallyExam(v(9, "wrong"));
    expect(t.failed).toBe(true);
    expect(t.passed).toBe(false);
  });

  it("does not fail at 8 misses, since 12 is still reachable", () => {
    const t = tallyExam(v(8, "wrong"));
    expect(t.failed).toBe(false);
    expect(t.remainingToPass).toBe(12);
  });

  it("reports not-yet-decided mid-exam", () => {
    const t = tallyExam([...v(5, "correct"), ...v(2, "wrong")]);
    expect(t.passed).toBe(false);
    expect(t.failed).toBe(false);
    expect(t.asked).toBe(7);
    expect(t.remainingToPass).toBe(7);
  });

  it("is empty-safe", () => {
    const t = tallyExam([]);
    expect(t).toMatchObject({ asked: 0, correct: 0, passed: false, failed: false, remainingToPass: 12 });
  });
});

describe("reporting", () => {
  it("counts mastery per section", () => {
    let p: Progress = emptyProgress();
    p = applyVerdict(p, 1, "correct");
    p = applyVerdict(p, 1, "correct");
    const stats = statsBySection(BANK, p);
    const principles = stats.find((s) => s.section === "Principles")!;
    expect(principles).toMatchObject({ total: 2, mastered: 1 });
    expect(stats.find((s) => s.section === "Holidays")).toMatchObject({ total: 1, mastered: 0 });
  });

  it("lists attempted-but-unmastered questions as weak, worst first", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong");
    p = applyVerdict(p, 3, "wrong");
    p = applyVerdict(p, 4, "risky");
    p = applyVerdict(p, 1, "correct");
    p = applyVerdict(p, 1, "correct"); // mastered, must not appear
    const weak = weakIds(BANK, p);
    expect(weak).toContain(3);
    expect(weak).toContain(4);
    expect(weak).not.toContain(1);
    expect(weak[0]).toBe(3); // two misses is worse than one risky
  });

  it("omits never-attempted questions from the weak list", () => {
    const weak = weakIds(BANK, emptyProgress());
    expect(weak).toEqual([]);
  });
});

describe("matchesOfficial: credit must be justified against the real answer list", () => {
  const JUDICIAL = ["Reviews laws", "Explains laws", "Resolves disputes (disagreements) about the law"];
  const TERM = ["Six (6) years"];
  const SUPREME = ["(U.S.) Constitution"];

  it("accepts an exact listed answer", () => {
    expect(matchesOfficial("Explains laws", JUDICIAL)).toBe(true);
  });

  it("ignores case and punctuation", () => {
    expect(matchesOfficial("explains laws!", JUDICIAL)).toBe(true);
  });

  it("sees through the editorial parentheses USCIS uses", () => {
    expect(matchesOfficial("six years", TERM)).toBe(true);
    expect(matchesOfficial("Constitution", SUPREME)).toBe(true);
  });

  it("accepts a listed answer quoted with its parentheses intact", () => {
    expect(matchesOfficial("Six (6) years", TERM)).toBe(true);
  });

  it("rejects an answer that is not on the list", () => {
    expect(matchesOfficial("interpret the law", JUDICIAL)).toBe(false);
  });

  it("rejects a fabricated match, which is the whole point", () => {
    // The regression this guards: "apple mattocks" credited on "who wrote the
    // Declaration of Independence", whose only listed answer is Jefferson.
    expect(matchesOfficial("apple mattocks", ["(Thomas) Jefferson"])).toBe(false);
  });

  it("rejects empty and near-empty claims", () => {
    expect(matchesOfficial("", JUDICIAL)).toBe(false);
    expect(matchesOfficial("  ", JUDICIAL)).toBe(false);
    expect(matchesOfficial("a", JUDICIAL)).toBe(false);
  });

  it("does not let a stray fragment count as a match", () => {
    expect(matchesOfficial("the", JUDICIAL)).toBe(false);
  });

  it("rejects everything when the answer list is empty", () => {
    expect(matchesOfficial("anything", [])).toBe(false);
  });

  it("tolerates the spelling drift a grader introduces", () => {
    // Regression: substring matching could not see these as the same answer.
    expect(matchesOfficial("Martin Luther King Junior Day", ["Martin Luther King, Jr. Day"])).toBe(true);
    expect(matchesOfficial("Presidents Day", ["Presidents Day (Washington's Birthday)"])).toBe(true);
  });
});

describe("citationSatisfies: questions that demand several items", () => {
  const HOLIDAYS = [
    "New Year's Day",
    "Martin Luther King, Jr. Day",
    "Presidents Day (Washington's Birthday)",
    "Memorial Day",
    "Juneteenth",
    "Independence Day",
    "Labor Day",
    "Columbus Day",
    "Veterans Day",
    "Thanksgiving Day",
    "Christmas Day",
  ];

  it("accepts three distinct holidays cited in one string", () => {
    // Regression: this correct answer was being downgraded to wrong.
    expect(citationSatisfies("Labor Day, Martin Luther King Junior Day, and Columbus Day", HOLIDAYS, 3)).toBe(true);
  });

  it("accepts a newline-separated citation", () => {
    expect(citationSatisfies("Labor Day\nMemorial Day\nChristmas Day", HOLIDAYS, 3)).toBe(true);
  });

  it("rejects a citation short of the required count", () => {
    expect(citationSatisfies("Christmas Day", HOLIDAYS, 3)).toBe(false);
    expect(citationSatisfies("Labor Day and Columbus Day", HOLIDAYS, 3)).toBe(false);
  });

  it("does not let the same holiday count three times", () => {
    expect(citationSatisfies("Christmas Day, Christmas Day, Christmas Day", HOLIDAYS, 3)).toBe(false);
  });

  it("rejects invented items", () => {
    expect(citationSatisfies("Labor Day, Boxing Day, and Bastille Day", HOLIDAYS, 3)).toBe(false);
  });

  it("falls back to single-answer matching when only one item is required", () => {
    expect(citationSatisfies("Labor Day", HOLIDAYS, 1)).toBe(true);
    expect(citationSatisfies("Boxing Day", HOLIDAYS, 1)).toBe(false);
  });
});

describe("dueLapsedIds: what loop mode re-injects", () => {
  it("is empty when nothing has been attempted", () => {
    expect(dueLapsedIds(emptyProgress(), ids)).toEqual([]);
  });

  it("does not surface a miss before it comes due", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong"); // due = step + 3
    expect(dueLapsedIds(p, ids)).toEqual([]);
  });

  it("surfaces a miss once it comes due", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong");
    for (const id of [4, 5, 6]) p = applyVerdict(p, id, "correct"); // advance the clock
    expect(dueLapsedIds(p, ids)).toContain(3);
  });

  it("excludes the question just asked, so a miss is not re-asked immediately", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong");
    for (const id of [4, 5, 6]) p = applyVerdict(p, id, "correct");
    expect(dueLapsedIds(p, ids, 3)).not.toContain(3);
  });

  it("never surfaces a question answered correctly", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "correct");
    for (const id of [4, 5, 6, 7]) p = applyVerdict(p, id, "correct");
    expect(dueLapsedIds(p, ids)).not.toContain(3);
  });

  it("surfaces a risky answer, since risky never advances the streak", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "risky");
    for (const id of [4, 5, 6, 7]) p = applyVerdict(p, id, "correct");
    expect(dueLapsedIds(p, ids)).toContain(3);
  });

  it("orders the worst-overdue first", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong");
    p = applyVerdict(p, 4, "wrong");
    for (const id of [5, 6, 7, 8]) p = applyVerdict(p, id, "correct");
    expect(dueLapsedIds(p, ids)[0]).toBe(3);
  });
});

describe("examPlan as a full shuffle (loop mode cycles)", () => {
  it("returns every question exactly once when length equals the bank", () => {
    const plan = examPlan(BANK, Math.random, BANK.length);
    expect(plan).toHaveLength(BANK.length);
    expect(new Set(plan).size).toBe(BANK.length);
    expect([...plan].sort((a, b) => a - b)).toEqual(ids);
  });

  it("covers every question even when asked for more than exist", () => {
    const plan = examPlan(BANK, Math.random, 999);
    expect([...plan].sort((a, b) => a - b)).toEqual(ids);
  });
});

describe("countRequired: only counts items the question asks you to produce", () => {
  it("counts an explicit request", () => {
    expect(countRequired("Name three national U.S. holidays.")).toBe(3);
    expect(countRequired("Name two important ideas from the Declaration of Independence.")).toBe(2);
    expect(countRequired("What are two Cabinet-level positions?")).toBe(2);
    expect(countRequired("What are three rights of everyone living in the United States?")).toBe(3);
    expect(countRequired("There were 13 original states. Name five.")).toBe(5);
  });

  it("ignores a number that is merely mentioned", () => {
    // Regression: "two senators" made this demand two cited answers, so the
    // listed answer "Equal representation (for small states)" was marked wrong.
    expect(countRequired("Why does each state have two senators?")).toBe(1);
    expect(countRequired("There are three branches of government. Why?")).toBe(1);
    expect(countRequired("The President of the United States can serve only two terms. Why?")).toBe(1);
    expect(countRequired("Why does the flag have 13 stripes?")).toBe(1);
  });

  it("treats a definite article as one known set", () => {
    // "the three branches" has a single listed answer: "Legislative, executive, and judicial".
    expect(countRequired("Name the three branches of government.")).toBe(1);
    expect(countRequired("What are the two parts of the U.S. Congress?")).toBe(1);
  });

  it("uses the requested count, not an earlier number in the sentence", () => {
    expect(
      countRequired("There are four amendments to the U.S. Constitution about who can vote. Describe one of them."),
    ).toBe(1);
  });

  it("defaults to one", () => {
    expect(countRequired("What is the supreme law of the land?")).toBe(1);
    expect(countRequired("")).toBe(1);
  });
});

describe("matchesOfficial: USCIS parentheses mark optional wording", () => {
  it("accepts the answer with and without the optional part", () => {
    // Regression: stripping "(Thomas)" left "jefferson", so the fuller and more
    // natural "Thomas Jefferson" scored 0.5 and was rejected as a fabrication.
    expect(matchesOfficial("Thomas Jefferson", ["(Thomas) Jefferson"])).toBe(true);
    expect(matchesOfficial("Jefferson", ["(Thomas) Jefferson"])).toBe(true);
    expect(matchesOfficial("(Thomas) Jefferson", ["(Thomas) Jefferson"])).toBe(true);
  });

  it("handles the other parenthetical shapes in the bank", () => {
    expect(matchesOfficial("six years", ["Six (6) years"])).toBe(true);
    expect(matchesOfficial("U.S. Constitution", ["(U.S.) Constitution"])).toBe(true);
    expect(matchesOfficial("Constitution", ["(U.S.) Constitution"])).toBe(true);
    expect(matchesOfficial("Equal representation", ["Equal representation (for small states)"])).toBe(true);
  });

  it("still rejects a different name entirely", () => {
    expect(matchesOfficial("Thomas Paine", ["(Thomas) Jefferson"])).toBe(false);
    expect(matchesOfficial("apple mattocks", ["(Thomas) Jefferson"])).toBe(false);
  });

  it("accepts a citation that lists several answers at once", () => {
    const holidays = ["Labor Day", "Columbus Day", "Christmas Day"];
    expect(citationSatisfies("Labor Day; Columbus Day; Christmas Day", holidays, 1)).toBe(true);
  });

  it("does not shred a listed answer that contains its own 'and'", () => {
    expect(citationSatisfies("Senate and House (of Representatives)", ["Senate and House (of Representatives)"], 1)).toBe(
      true,
    );
  });
});

describe("isPlaceholderAnswer: the eight questions the PDF cannot answer", () => {
  it("detects the officeholder placeholder", () => {
    expect(
      isPlaceholderAnswer("Visit uscis.gov/citizenship/testupdates for the name of the President of the United States."),
    ).toBe(true);
  });

  it("detects the state-specific placeholder", () => {
    expect(isPlaceholderAnswer("Answers will vary. [District of Columbia residents ...]")).toBe(true);
  });

  it("does not flag a real answer", () => {
    expect(isPlaceholderAnswer("Equal representation (for small states)")).toBe(false);
    expect(isPlaceholderAnswer("(Thomas) Jefferson")).toBe(false);
  });

  it("needsLocalAnswers is true only when every answer is a placeholder", () => {
    expect(needsLocalAnswers(["Answers will vary."])).toBe(true);
    expect(needsLocalAnswers(["Mike Johnson"])).toBe(false);
    expect(needsLocalAnswers([])).toBe(false);
  });
});

describe("dueConfirmIds: closing out near-mastered questions", () => {
  it("surfaces a question sitting one correct answer from mastery", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "correct"); // streak 1, due = step + 6
    for (const id of [4, 5, 6, 7, 8, 9]) p = applyVerdict(p, id, "correct");
    expect(recordOf(p, 3).streak).toBe(1);
    expect(dueConfirmIds(p, ids)).toContain(3);
  });

  it("does not surface it before it comes due", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "correct");
    expect(dueConfirmIds(p, ids)).toEqual([]);
  });

  it("stops surfacing it once mastered", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "correct");
    p = applyVerdict(p, 3, "correct"); // mastered
    for (const id of [4, 5, 6, 7, 8, 9]) p = applyVerdict(p, id, "correct");
    expect(dueConfirmIds(p, ids)).not.toContain(3);
  });

  it("does not surface a question that was missed: that is a repair, not a confirm", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong");
    for (const id of [4, 5, 6, 7]) p = applyVerdict(p, id, "correct");
    expect(dueConfirmIds(p, ids)).not.toContain(3);
    expect(dueLapsedIds(p, ids)).toContain(3);
  });

  it("keeps repair and confirm pools disjoint", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "wrong"); // streak 0 -> repair
    p = applyVerdict(p, 4, "correct"); // streak 1 -> confirm
    for (const id of [5, 6, 7, 8, 9, 1]) p = applyVerdict(p, id, "risky");
    const repair = new Set(dueLapsedIds(p, ids));
    const confirm = new Set(dueConfirmIds(p, ids));
    expect([...repair].filter((x) => confirm.has(x))).toEqual([]);
  });

  it("treats a risky answer on a streak-1 question as still needing confirmation", () => {
    let p = emptyProgress();
    p = applyVerdict(p, 3, "correct"); // streak 1
    p = applyVerdict(p, 3, "risky"); // risky holds the streak at 1
    for (const id of [4, 5, 6, 7, 8]) p = applyVerdict(p, id, "correct");
    expect(recordOf(p, 3).streak).toBe(1);
    expect(dueConfirmIds(p, ids)).toContain(3);
  });
});

describe("fastPathMatch: skipping the model without giving away credit", () => {
  const JUDICIAL = ["Reviews laws", "Explains laws", "Resolves disputes (disagreements) about the law"];
  const TERM = ["Six (6) years"];
  const AUTHOR = ["(Thomas) Jefferson"];
  const RIVAL = ["Soviet Union", "USSR", "Russia"];
  const HOLIDAYS = ["Labor Day", "Columbus Day", "Christmas Day"];

  it("credits a verbatim listed answer", () => {
    expect(fastPathMatch("explains laws", JUDICIAL, 1)).toBe("Explains laws");
    expect(fastPathMatch("six years", TERM, 1)).toBe("Six (6) years");
    expect(fastPathMatch("Thomas Jefferson", AUTHOR, 1)).toBe("(Thomas) Jefferson");
  });

  it("tolerates casing and punctuation only", () => {
    expect(fastPathMatch("EXPLAINS LAWS!", JUDICIAL, 1)).toBe("Explains laws");
  });

  it("refuses a paraphrase, which must go to the model to be judged risky", () => {
    expect(fastPathMatch("interpret the law", JUDICIAL, 1)).toBeNull();
    expect(fastPathMatch("it explains what laws mean", JUDICIAL, 1)).toBeNull();
  });

  it("refuses a wrong answer that shares words with a right one", () => {
    expect(fastPathMatch("four years", TERM, 1)).toBeNull();
    expect(fastPathMatch("two years", TERM, 1)).toBeNull();
    expect(fastPathMatch("Thomas Paine", AUTHOR, 1)).toBeNull();
  });

  it("refuses short or empty transcripts", () => {
    expect(fastPathMatch("", JUDICIAL, 1)).toBeNull();
    expect(fastPathMatch("no", JUDICIAL, 1)).toBeNull();
    expect(fastPathMatch("the", JUDICIAL, 1)).toBeNull();
    expect(fastPathMatch("uh", RIVAL, 1)).toBeNull();
  });

  it("never fires on a multi-item question, where counting is required", () => {
    // "Labor Day" alone must not credit "name three holidays".
    expect(fastPathMatch("Labor Day", HOLIDAYS, 3)).toBeNull();
    expect(fastPathMatch("Labor Day", HOLIDAYS, 1)).toBe("Labor Day");
  });

  it("refuses a placeholder answer even if the transcript resembles it", () => {
    expect(
      fastPathMatch("visit uscis.gov for the name", ["Visit uscis.gov/citizenship/testupdates for the name."], 1),
    ).toBeNull();
  });

  it("is stricter than the citation check, on purpose", () => {
    // The citation check accepts this drift; the fast path must not, because here
    // no model has looked at the answer.
    expect(matchesOfficial("Martin Luther King Junior Day", ["Martin Luther King, Jr. Day"])).toBe(true);
    expect(fastPathMatch("Martin Luther King Junior Day", ["Martin Luther King, Jr. Day"], 1)).toBeNull();
  });

  it("credits one listed answer out of several alternatives", () => {
    expect(fastPathMatch("Russia", RIVAL, 1)).toBe("Russia");
    expect(fastPathMatch("USSR", RIVAL, 1)).toBe("USSR");
  });
});
