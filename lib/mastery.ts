/**
 * Pure mastery + scheduling logic for the USCIS civics trainer.
 *
 * Nothing in this file does I/O or calls a model. The agent decides *verdicts*;
 * every number derived from them is computed here so it stays reproducible.
 *
 * The on-disk `Progress` shape is deliberately compatible with the companion
 * `~/civics-study/drill.py` CLI: same `step` / `q` fields, and log entries carry
 * a boolean `ok` alongside the richer `verdict`.
 */

export type Verdict = "correct" | "risky" | "wrong";
/**
 * exam     - 20 questions, section-weighted, stops at 12 correct.
 * practice - scheduler-driven, weakest first, ends when the pool is mastered.
 * loop     - infinite: covers every question in random order, cycle after cycle,
 *            injecting missed questions back in early. Never ends.
 */
export type Mode = "exam" | "practice" | "loop";

export interface Question {
  id: number;
  part: string;
  section: string;
  question: string;
  answers: string[];
  starred: boolean;
}

export interface QRecord {
  attempts: number;
  correct: number;
  streak: number;
  due: number;
  last?: string;
}

export interface LogEntry {
  step: number;
  id: number;
  verdict: Verdict;
  /** Kept for drill.py compatibility: only a full `correct` counts as ok. */
  ok: boolean;
}

export interface Progress {
  step: number;
  q: Record<string, QRecord>;
  log: LogEntry[];
}

export interface SectionStat {
  part: string;
  section: string;
  total: number;
  mastered: number;
}

export interface ExamTally {
  asked: number;
  correct: number;
  remainingToPass: number;
  passed: boolean;
  failed: boolean;
}

/** Two consecutive fully-correct answers. `risky` holds; `wrong` resets. */
export const MASTERY_STREAK = 2;
/** The officer asks up to 20 questions. */
export const EXAM_LENGTH = 20;
/** 12 correct passes. The officer stops early once you reach it. */
export const EXAM_PASS_MARK = 12;

/**
 * How many steps until a question resurfaces. Missing something brings it back
 * fastest; a paraphrase brings it back soon; a clean answer buys more room.
 */
const DUE_OFFSET: Record<Verdict, number> = { wrong: 3, risky: 4, correct: 6 };
/** Effectively "never again" once mastered. Mirrors drill.py's 10**9. */
const DUE_MASTERED = 1_000_000_000;

const FRESH: QRecord = { attempts: 0, correct: 0, streak: 0, due: 0 };

export type Picker = <T>(candidates: T[]) => T;

export const emptyProgress = (): Progress => ({ step: 0, q: {}, log: [] });

export function recordOf(progress: Progress, questionId: number): QRecord {
  return progress.q[String(questionId)] ?? { ...FRESH };
}

export const isMastered = (record: QRecord): boolean => record.streak >= MASTERY_STREAK;

/**
 * Apply a verdict, returning new progress. Never mutates its input.
 *
 * The three verdicts differ only here, and this is the whole reason the tier
 * system works: `risky` advances nothing, so a paraphrased answer keeps the
 * question in circulation without punishing you for it on the exam.
 */
export function applyVerdict(progress: Progress, questionId: number, verdict: Verdict): Progress {
  const step = progress.step + 1;
  const prev = recordOf(progress, questionId);

  const streak = verdict === "correct" ? prev.streak + 1 : verdict === "wrong" ? 0 : prev.streak;
  const mastered = streak >= MASTERY_STREAK;

  const next: QRecord = {
    attempts: prev.attempts + 1,
    correct: prev.correct + (verdict === "correct" ? 1 : 0),
    streak,
    due: step + (mastered ? DUE_MASTERED : DUE_OFFSET[verdict]),
    last: new Date().toISOString().slice(0, 10),
  };

  return {
    step,
    q: { ...progress.q, [String(questionId)]: next },
    log: [...progress.log, { step, id: questionId, verdict, ok: verdict === "correct" }],
  };
}

/** Ids from `pool` that are not yet mastered, in pool order. */
export function pendingIds(progress: Progress, pool: number[]): number[] {
  return pool.filter((id) => !isMastered(recordOf(progress, id)));
}

function dueWhere(
  progress: Progress,
  pool: number[],
  exclude: number | null | undefined,
  match: (record: QRecord) => boolean,
): number[] {
  return pool
    .filter((id) => {
      if (id === exclude) return false;
      const r = recordOf(progress, id);
      return r.attempts > 0 && r.due <= progress.step && match(r);
    })
    .sort((a, b) => recordOf(progress, a).due - recordOf(progress, b).due || a - b);
}

/**
 * REPAIR candidates: questions you got wrong (streak back to zero) that have come
 * due. Re-injected a few questions after the miss rather than a whole cycle later.
 */
export function dueLapsedIds(progress: Progress, pool: number[], exclude?: number | null): number[] {
  return dueWhere(progress, pool, exclude, (r) => r.streak === 0);
}

/**
 * CONFIRM candidates: questions one clean answer away from mastery.
 *
 * Mastery needs two consecutive `correct`, so a question at streak 1 is the
 * cheapest possible progress: one right answer converts it. Without this the loop
 * only ever repaired mistakes and left near-mastered questions to reappear
 * whenever the shuffle happened to reach them, up to a full cycle later.
 */
export function dueConfirmIds(progress: Progress, pool: number[], exclude?: number | null): number[] {
  return dueWhere(progress, pool, exclude, (r) => r.streak === MASTERY_STREAK - 1);
}

/**
 * Choose the next question.
 *
 * Lapsed questions (attempted, streak back at zero) always jump the queue ahead
 * of merely-due ones. Without that rule a fresh miss would sit behind every
 * question scheduled earlier in the session, which is exactly backwards: the
 * thing you just got wrong is the thing you most need to see again.
 */
export function nextQuestionId(
  progress: Progress,
  pool: number[],
  pick: Picker = (xs) => xs[Math.floor(Math.random() * xs.length)],
): number | null {
  const pending = pendingIds(progress, pool);
  if (pending.length === 0) return null;

  const lapsed = pending.filter((id) => {
    const r = recordOf(progress, id);
    return r.attempts > 0 && r.streak === 0;
  });
  const tier = lapsed.length > 0 ? lapsed : pending;

  const lowestDue = Math.min(...tier.map((id) => recordOf(progress, id).due));
  return pick(tier.filter((id) => recordOf(progress, id).due === lowestDue));
}

/**
 * Build an exam whose section mix mirrors the bank's own composition, the way a
 * real officer's 20 questions are drawn from all 128.
 */
export function examPlan(
  bank: Question[],
  rng: () => number = Math.random,
  length: number = EXAM_LENGTH,
): number[] {
  if (bank.length === 0) return [];
  if (length >= bank.length) return shuffle(bank.map((q) => q.id), rng);

  const parts: string[] = [];
  const byPart = new Map<string, Question[]>();
  for (const q of bank) {
    if (!byPart.has(q.part)) {
      byPart.set(q.part, []);
      parts.push(q.part);
    }
    byPart.get(q.part)!.push(q);
  }

  // Proportional quotas, with the rounding remainder going to the largest
  // fractional shares so the plan always totals exactly `length`.
  const ideal = parts.map((p) => (length * byPart.get(p)!.length) / bank.length);
  const quota = ideal.map(Math.floor);
  const order = parts
    .map((_, i) => i)
    .sort((a, b) => ideal[b] - Math.floor(ideal[b]) - (ideal[a] - Math.floor(ideal[a])));

  let short = length - quota.reduce((a, b) => a + b, 0);
  for (let i = 0; short > 0; i = (i + 1) % order.length) {
    const idx = order[i];
    if (quota[idx] < byPart.get(parts[idx])!.length) {
      quota[idx] += 1;
      short -= 1;
    }
  }

  return shuffle(
    parts.flatMap((p, i) => shuffle(byPart.get(p)!.map((q) => q.id), rng).slice(0, quota[i])),
    rng,
  );
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * USCIS pass/fail arithmetic. `risky` counts here but not toward mastery: a real
 * officer would accept the paraphrase, so the exam simulation must too.
 */
export function tallyExam(verdicts: Verdict[]): ExamTally {
  const asked = verdicts.length;
  const correct = verdicts.filter((v) => v === "correct" || v === "risky").length;
  const passed = correct >= EXAM_PASS_MARK;
  // Failed once 12 is arithmetically out of reach, not merely once 20 are asked.
  const failed = !passed && (asked >= EXAM_LENGTH || EXAM_LENGTH - asked + correct < EXAM_PASS_MARK);

  return { asked, correct, remainingToPass: Math.max(0, EXAM_PASS_MARK - correct), passed, failed };
}

export function statsBySection(bank: Question[], progress: Progress): SectionStat[] {
  const out: SectionStat[] = [];
  const index = new Map<string, SectionStat>();

  for (const q of bank) {
    const key = `${q.part} ${q.section}`;
    let stat = index.get(key);
    if (!stat) {
      stat = { part: q.part, section: q.section, total: 0, mastered: 0 };
      index.set(key, stat);
      out.push(stat);
    }
    stat.total += 1;
    if (isMastered(recordOf(progress, q.id))) stat.mastered += 1;
  }
  return out;
}

/**
 * Does `claimed` correspond to a real entry on the official answer list?
 *
 * Used to verify a `correct` or `risky` verdict: the grader must name the listed
 * answer it credited, and this checks the receipt. Without it, a mangled
 * transcript can be "rescued" into an answer USCIS does not actually accept.
 *
 * Official answers carry editorial parentheses ("(U.S.) Constitution", "Six (6)
 * years"), so comparison is on a normalized form. Containment counts in either
 * direction, so "Constitution" satisfies "(U.S.) Constitution".
 */
function normalizeCore(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The accepted readings of one answer string.
 *
 * USCIS parentheses mark *optional* wording, so "(Thomas) Jefferson" accepts both
 * "Jefferson" and "Thomas Jefferson", and "Six (6) years" accepts "six years".
 * Dropping the parenthetical text outright, as an earlier version did, made the
 * fuller answer fail to match its own listed form: "Thomas Jefferson" scored 0.5
 * against the reduced "jefferson" and was rejected as a fabrication.
 */
function variantsOf(entry: string): string[] {
  const withInner = normalizeCore(entry.replace(/[()]/g, " "));
  const withoutInner = normalizeCore(entry.replace(/\([^)]*\)/g, " "));
  return [...new Set([withInner, withoutInner])].filter((v) => v.length >= 3);
}

function normalizeAnswer(s: string): string {
  return normalizeCore(s.replace(/\([^)]*\)/g, " "));
}

/** Minimum token-set overlap (Jaccard) for two answers to count as the same. */
const CITATION_SIMILARITY = 0.6;
/**
 * Much stricter bar for skipping the model entirely. A citation check only has to
 * recognise the grader's own paraphrase of a listed answer; the fast path is
 * awarding credit with nobody watching, so it demands near-identity.
 */
const FAST_PATH_SIMILARITY = 0.9;

function similar(a: string, b: string, threshold = CITATION_SIMILARITY): boolean {
  if (a === b) return true;

  // Token overlap rather than substring: it tolerates the spelling drift a
  // grader introduces ("Martin Luther King Junior Day" for the listed "Martin
  // Luther King, Jr. Day") while still rejecting a stray common word like "the",
  // which shares one token out of five and scores far below the threshold.
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;

  const union = left.size + right.size - shared;
  return union > 0 && shared / union >= threshold;
}

/**
 * Does `claimed` correspond to a real entry on the official answer list?
 *
 * Used to verify a `correct` or `risky` verdict: the grader must name the listed
 * answer it credited, and this checks the receipt. Without it, a mangled
 * transcript can be "rescued" into an answer USCIS does not actually accept.
 */
export function matchesOfficial(claimed: string, official: string[]): boolean {
  // Both sides get variant treatment: the grader may quote an answer with or
  // without its optional parenthetical wording, and either should be accepted.
  const targets = variantsOf(claimed);
  if (targets.length === 0) return false;

  return official.some((entry) =>
    variantsOf(entry).some((candidate) => targets.some((target) => similar(target, candidate))),
  );
}

/**
 * Verify a citation for a question that demands several items ("name three
 * national holidays").
 *
 * The grader cites all of them in one string, so it is split on separators and
 * each part matched independently. `required` distinct official entries must be
 * covered; citing the same holiday three ways does not count as three.
 */
export function citationSatisfies(claimed: string, official: string[], required = 1): boolean {
  const need = Math.max(1, required);

  // Whole string first. Several listed answers contain "and" or commas of their
  // own ("Senate and House (of Representatives)"), and splitting those would
  // shred a perfectly good citation into fragments that match nothing.
  if (need === 1 && matchesOfficial(claimed, official)) return true;

  const parts = claimed
    .split(/[,;/]|\band\b|\n/)
    .map(normalizeAnswer)
    .filter((p) => p.length >= 3);

  const covered = new Set<number>();
  for (const part of parts) {
    official.forEach((entry, index) => {
      if (variantsOf(entry).some((candidate) => similar(part, candidate))) covered.add(index);
    });
  }
  return covered.size >= need;
}

/**
 * How many items the applicant must supply.
 *
 * Only counts a number that the question *asks them to produce*: "Name three
 * national holidays" wants three, but "Why does each state have two senators?"
 * wants one reason and merely mentions the number two. A naive scan for any
 * number word marked correct answers wrong, which is the worst possible failure
 * for a study tool.
 *
 * A definite article flips the meaning too. "Name the three branches" is one
 * known set and has a single listed answer; "Name three holidays" is a choice of
 * three from eleven.
 */
/**
 * Is this "answer" actually a placeholder rather than an answer?
 *
 * Eight questions in the bank cannot be graded from the PDF alone. Four depend on
 * who currently holds an office and list "Visit uscis.gov/..." instead of a name;
 * four depend on where you live and list "Answers will vary." Grading a real reply
 * against those strings marks every answer wrong, so they need local values.
 */
export function isPlaceholderAnswer(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a.startsWith("visit uscis.gov") || a.startsWith("answers will vary");
}

/** True when every listed answer is a placeholder, so the question needs local data. */
export const needsLocalAnswers = (answers: string[]): boolean =>
  answers.length > 0 && answers.every(isPlaceholderAnswer);

/**
 * Can this answer be credited without asking a model?
 *
 * Returns the matched official answer when the transcript is near-identical to a
 * listed one, otherwise null. This is the fast path: a well-prepared answer is
 * graded in microseconds instead of waiting ~1.2s on Bedrock, which is the common
 * case once you actually know the material.
 *
 * Deliberately conservative. It only fires for single-answer questions, demands
 * 0.9 token overlap rather than the 0.6 used for citation checks, and refuses
 * short transcripts. Anything less certain goes to the model, because awarding
 * credit wrongly is far worse than waiting a second.
 */
export function fastPathMatch(transcript: string, official: string[], answersRequired: number): string | null {
  if (answersRequired !== 1) return null;

  // `variantsOf` already drops anything under 3 characters, which covers filler
  // like "no" and "uh". No extra length rule: a minimum word count would reject
  // legitimately short answers such as "USSR", and the 0.9 similarity threshold
  // is what actually keeps a stray word like "the" from matching.
  const targets = variantsOf(transcript);
  if (targets.length === 0) return null;

  for (const entry of official) {
    if (isPlaceholderAnswer(entry)) continue;
    for (const candidate of variantsOf(entry)) {
      for (const target of targets) {
        if (similar(target, candidate, FAST_PATH_SIMILARITY)) return entry;
      }
    }
  }
  return null;
}

export function countRequired(questionText: string): number {
  const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  // The number must directly follow a request ("name three", "what are two"),
  // optionally via "the", which we then reject.
  const pattern = /\b(?:name|describe|list|give|identify|what are)\s+(the\s+)?(one|two|three|four|five)\b/g;

  for (const match of questionText.toLowerCase().matchAll(pattern)) {
    if (match[1]) continue; // "the three branches": a single known answer
    return WORDS[match[2]];
  }
  return 1;
}

/** Attempted but not mastered, worst first. Never-attempted questions are not "weak". */
export function weakIds(bank: Question[], progress: Progress): number[] {
  return bank
    .filter((q) => {
      const r = recordOf(progress, q.id);
      return r.attempts > 0 && !isMastered(r);
    })
    .sort((a, b) => {
      const ra = recordOf(progress, a.id);
      const rb = recordOf(progress, b.id);
      // More non-correct attempts is worse; then a colder streak; then stable by id.
      return (
        rb.attempts - rb.correct - (ra.attempts - ra.correct) ||
        ra.streak - rb.streak ||
        a.id - b.id
      );
    })
    .map((q) => q.id);
}

/**
 * Replace the most recent verdict for `questionId` with `verdict`.
 *
 * Used by the self-grade override ("I said it right"): the offline grader marked an
 * answer wrong, the applicant says it was actually fine, and the record must look
 * exactly as if the corrected verdict had been applied in the first place. Applying
 * a second verdict on top would double count the attempt and leave the streak reset.
 *
 * `prior` is the question's record as it stood before that verdict was applied
 * (null if the question had never been attempted). The last log entry is undone,
 * `step` steps back, the record is restored, and the new verdict is replayed with
 * `applyVerdict`. Never mutates its input.
 *
 * Returns null when the most recent log entry is not for `questionId`, meaning
 * something else has been recorded since and there is nothing safe to revise.
 */
export function reviseLastVerdict(
  progress: Progress,
  questionId: number,
  verdict: Verdict,
  prior: QRecord | null,
): Progress | null {
  const last = progress.log[progress.log.length - 1];
  if (!last || last.id !== questionId || last.step !== progress.step) return null;

  const q = { ...progress.q };
  if (prior) q[String(questionId)] = { ...prior };
  else delete q[String(questionId)];

  const before: Progress = { step: progress.step - 1, q, log: progress.log.slice(0, -1) };
  return applyVerdict(before, questionId, verdict);
}
