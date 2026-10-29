/**
 * Regression tests against the real 128-question bank.
 *
 * These exist because three separate bugs shipped that all had the same shape: a
 * *correct* answer being marked wrong. Unit tests on synthetic data missed all
 * three, because each depended on the exact phrasing USCIS uses.
 *
 *   Q28  "Why does each state have two senators?" -> "two" was read as a demand
 *        for two cited answers, so the listed answer failed the citation check.
 *   Q78  "(Thomas) Jefferson" -> stripping the optional first name meant the
 *        natural answer "Thomas Jefferson" no longer matched its own entry.
 *   Q30  "Visit uscis.gov/..." is a placeholder, so every reply was wrong.
 *
 * The invariant below would have caught all three: every official answer must
 * validate against its own question. Offline, no model, no network. The bank is
 * the copy bundled into this app at data/questions.json.
 */

import { describe, it, expect } from "vitest";
import bundled from "../data/questions.json";
import {
  citationSatisfies,
  countRequired,
  isPlaceholderAnswer,
  matchesOfficial,
  needsLocalAnswers,
  type Question,
} from "./mastery";

const bank = bundled as Question[];
const present = bank.length > 0;

/** Questions that can actually be graded from the PDF alone. */
const gradeable = bank.filter((q) => !needsLocalAnswers(q.answers));

describe.skipIf(!present)("the real question bank", () => {
  it("has 128 questions and 20 starred", () => {
    expect(bank).toHaveLength(128);
    expect(bank.filter((q) => q.starred)).toHaveLength(20);
  });

  it("has exactly 8 questions needing local answers", () => {
    const needing = bank.filter((q) => needsLocalAnswers(q.answers)).map((q) => q.id);
    expect(needing).toEqual([23, 29, 30, 38, 39, 57, 61, 62]);
  });

  it("every official answer validates against its own question", () => {
    const failures: string[] = [];
    for (const q of gradeable) {
      for (const answer of q.answers) {
        if (isPlaceholderAnswer(answer)) continue;
        if (!matchesOfficial(answer, q.answers)) failures.push(`Q${q.id}: "${answer}"`);
      }
    }
    expect(failures, `answers that fail their own citation check:\n${failures.join("\n")}`).toEqual([]);
  });

  it("every official answer passes the citation guard the grader uses", () => {
    const failures: string[] = [];
    for (const q of gradeable) {
      for (const answer of q.answers) {
        if (isPlaceholderAnswer(answer)) continue;
        if (!citationSatisfies(answer, q.answers, 1)) failures.push(`Q${q.id}: "${answer}"`);
      }
    }
    expect(failures, `answers rejected by the guard:\n${failures.join("\n")}`).toEqual([]);
  });

  it("an answer stripped of its optional parenthetical still validates", () => {
    // "(Thomas) Jefferson" must accept "Jefferson"; "Six (6) years" must accept "six years".
    const failures: string[] = [];
    for (const q of gradeable) {
      for (const answer of q.answers) {
        if (!answer.includes("(")) continue;
        const stripped = answer.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
        const inlined = answer.replace(/[()]/g, "").replace(/\s+/g, " ").trim();
        if (stripped.length >= 3 && !matchesOfficial(stripped, q.answers)) {
          failures.push(`Q${q.id}: stripped "${stripped}" from "${answer}"`);
        }
        if (!matchesOfficial(inlined, q.answers)) {
          failures.push(`Q${q.id}: inlined "${inlined}" from "${answer}"`);
        }
      }
    }
    expect(failures, `parenthetical variants that fail:\n${failures.join("\n")}`).toEqual([]);
  });

  it("never demands more items than a question has answers", () => {
    const failures = gradeable
      .filter((q) => countRequired(q.question) > q.answers.length)
      .map((q) => `Q${q.id}: needs ${countRequired(q.question)} but lists ${q.answers.length} — ${q.question}`);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("only demands multiple items where the question actually asks for a list", () => {
    // Every multi-item question must contain an explicit request. If a question
    // demands 2+ without one, countRequired has picked up an incidental number.
    const failures = gradeable
      .filter((q) => countRequired(q.question) > 1)
      .filter((q) => !/\b(name|describe|list|give|identify|what are)\b/i.test(q.question))
      .map((q) => `Q${q.id}: ${q.question}`);
    expect(failures, failures.join("\n")).toEqual([]);
  });

  it("lists the multi-item questions explicitly, so a change is visible", () => {
    const multi = gradeable
      .filter((q) => countRequired(q.question) > 1)
      .map((q) => [q.id, countRequired(q.question)] as const);
    expect(Object.fromEntries(multi)).toEqual({
      10: 2, // Name two important ideas...
      48: 2, // What are two Cabinet-level positions?
      65: 3, // What are three rights...
      67: 2, // Name two promises...
      69: 2, // What are two examples...
      81: 5, // Name five of the 13 original states
      126: 3, // Name three national U.S. holidays
    });
    // Q63 is deliberately absent: "There are four amendments ... Describe one of
    // them" mentions four but asks for one, which is the distinction that broke
    // Q28 ("Why does each state have two senators?").
  });
});
