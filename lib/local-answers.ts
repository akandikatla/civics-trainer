/**
 * Local answers for the eight questions the PDF cannot answer.
 *
 * Four depend on who currently holds an office (Speaker, President, Vice
 * President, Chief Justice) and the bank prints "Visit uscis.gov/..." in place of
 * a name. Four depend on where you live (your senators, your representative, your
 * governor, your state capital) and the bank prints "Answers will vary."
 *
 * Without local values these eight are ungradeable: any reply is marked wrong,
 * because it is compared against a placeholder string. They are bundled from
 * `data/local-answers.json` (filled in for Minnesota, ZIP 55347), and any
 * question still lacking an answer is skipped rather than asked, so the drill
 * never marks you wrong for a question it cannot grade.
 *
 * Officeholders change. On the real test the answer must match whoever is serving
 * on your interview date, so verify at uscis.gov/citizenship/testupdates.
 */

import bundled from "../data/local-answers.json";
import { needsLocalAnswers, type Question } from "./mastery";

export interface LocalAnswers {
  /** Free-text note, e.g. when the officeholders were last checked. */
  note?: string;
  state?: string;
  zip?: string;
  /** Question ids whose answers can change and must be re-checked before the interview. */
  verifyBeforeInterview?: number[];
  /** Question id -> accepted answers for this user, right now. */
  answers: Record<string, string[]>;
}

const parsed = bundled as Partial<LocalAnswers>;
const local: LocalAnswers = {
  note: parsed.note,
  state: parsed.state,
  zip: parsed.zip,
  verifyBeforeInterview: parsed.verifyBeforeInterview ?? [],
  answers: parsed.answers ?? {},
};

export function loadLocalAnswers(): LocalAnswers {
  return local;
}

/**
 * The answers to grade this question against, or null when it cannot be graded.
 * Local values win, so a stale placeholder never reaches the grader.
 */
export function resolveAnswers(question: Question): string[] | null {
  const answers = loadLocalAnswers().answers[String(question.id)];
  if (answers?.length) return answers;
  return needsLocalAnswers(question.answers) ? null : question.answers;
}

export const isGradeable = (question: Question): boolean => resolveAnswers(question) !== null;

/** Ids skipped for want of local data, so the UI can explain the gap. */
export function ungradeableIds(bank: Question[]): number[] {
  return bank.filter((q) => !isGradeable(q)).map((q) => q.id);
}

/** A question with its placeholder answers swapped for the local ones. */
export function withResolvedAnswers(question: Question): Question {
  return { ...question, answers: resolveAnswers(question) ?? question.answers };
}
