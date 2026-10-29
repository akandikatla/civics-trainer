/**
 * Shared grading cases.
 *
 * Used by lib/grader.test.ts against both grading pipelines.
 *
 * `expected` lists the outcomes the shipped MODEL pipeline (fast path, then the
 * distilled model with its decision rule and number guard) may return.
 * `offline` lists what the OFFLINE fallback (intelligibility, exact, fuzzy) may
 * return, when that differs; it never returns `risky`. `claude` records what the
 * original Bedrock-graded eval (eval/grading.test.ts in the main app) accepted
 * for the same transcript, where the case came from there.
 *
 * The model is strict by design (REPORT.md: under 2% false credit, about 36%
 * false rejection against Claude). Where it rejects an answer a person would
 * accept, the case says so in `why`; the applicant has "I said it right" and
 * "Close, but not exact" for exactly that. Expectations were never loosened
 * toward credit: every case that must not be credited still must not be.
 */

export type Outcome = "correct" | "risky" | "wrong" | "unintelligible";

export interface GradingCase {
  questionId: number;
  transcript: string;
  /** Outcomes the model pipeline may return. */
  expected: Outcome[];
  /** Outcomes the offline fallback may return, when different from `expected`. */
  offline?: Outcome[];
  /** Outcomes the original model-graded eval accepted, when the case came from it. */
  claude?: Outcome[];
  why: string;
}

/** Cases carried over from the model-graded eval (eval/grading.test.ts). */
export const MODEL_EVAL_CASES: GradingCase[] = [
  { questionId: 51, transcript: "interpret the law", expected: ["wrong"], claude: ["risky"], why: "paraphrase; the model scores it P(correct) 0.03, so wrong in both pipelines (REPORT's real-drill table agrees); use 'Close, but not exact'" },
  { questionId: 51, transcript: "explains laws", expected: ["correct"], claude: ["correct"], why: "verbatim listed answer" },
  { questionId: 103, transcript: "the economy became really bad and everyone was poor", expected: ["wrong"], claude: ["wrong"], why: "misses 'longest', the defining feature" },
  { questionId: 103, transcript: "the longest economic recession in modern history", expected: ["correct"], claude: ["correct"], why: "listed answer" },
  { questionId: 108, transcript: "Russia", expected: ["correct"], claude: ["correct"], why: "Russia is on the list" },
  { questionId: 94, transcript: "being president during the Civil War", expected: ["risky", "correct"], offline: ["wrong"], claude: ["correct", "risky"], why: "reworded 'Led the United States during the Civil War'; the GPU-distilled model credits the paraphrase as risky, as Claude does" },
  { questionId: 22, transcript: "six years", expected: ["correct"], claude: ["correct"], why: "listed answer, casual phrasing" },
  { questionId: 22, transcript: "four years", expected: ["wrong"], claude: ["wrong"], why: "presidential term; digits are exact-only" },
  { questionId: 126, transcript: "Labor Day, Martin Luther King Junior Day, and Columbus Day", expected: ["correct"], claude: ["correct"], why: "three valid holidays" },
  { questionId: 126, transcript: "Christmas", expected: ["wrong"], claude: ["wrong"], why: "three demanded, one given" },
  { questionId: 1, transcript: "a democracy", expected: ["wrong"], claude: ["risky", "wrong"], why: "drops the qualifier every listed answer carries" },
  { questionId: 107, transcript: "eyes and hour was a general in world war two", expected: ["correct"], claude: ["correct"], why: "credited via 'general ... world war two' (General during World War II), not via the mangled name" },
  { questionId: 78, transcript: "apple mattocks", expected: ["wrong", "unintelligible"], claude: ["unintelligible", "wrong"], why: "noise must never be rescued into Jefferson" },
  { questionId: 124, transcript: "out of many, one", expected: ["correct"], claude: ["correct"], why: "listed answer for E Pluribus Unum" },
];

/** Regression cases from the main app's eval/verify.test.ts that still apply. */
export const VERIFY_CASES: GradingCase[] = [
  { questionId: 28, transcript: "equal representation", expected: ["correct"], claude: ["correct"], why: "incidental 'two senators' must not demand two items" },
  { questionId: 78, transcript: "Thomas Jefferson", expected: ["correct"], claude: ["correct"], why: "optional '(Thomas)' kept" },
  { questionId: 39, transcript: "JD Vance", expected: ["correct"], claude: ["correct"], why: "local answer" },
  { questionId: 30, transcript: "Mike Johnson", expected: ["correct"], claude: ["correct"], why: "local answer" },
  { questionId: 38, transcript: "Donald Trump", expected: ["correct"], claude: ["correct"], why: "local answer" },
  { questionId: 57, transcript: "John Roberts", expected: ["correct"], claude: ["correct"], why: "local answer" },
  { questionId: 19, transcript: "Senate and House of Representatives", expected: ["correct"], claude: ["correct"], why: "answer containing its own 'and'" },
  { questionId: 16, transcript: "legislative, executive, and judicial", expected: ["correct"], claude: ["correct"], why: "'the three branches' is one answer" },
  { questionId: 2, transcript: "the Constitution", expected: ["correct"], claude: ["correct"], why: "(U.S.) Constitution" },
];

/** Minnesota (ZIP 55347) local answers, plus speech-recognition variants. */
export const MINNESOTA_CASES: GradingCase[] = [
  { questionId: 62, transcript: "saint paul", expected: ["correct"], why: "capital" },
  { questionId: 62, transcript: "st paul", expected: ["correct"], why: "abbreviated" },
  { questionId: 62, transcript: "St. Paul", expected: ["correct"], why: "abbreviated with period" },
  { questionId: 62, transcript: "the capital is Saint Paul", expected: ["correct"], why: "filler around the answer" },
  { questionId: 62, transcript: "Minneapolis", expected: ["wrong"], why: "largest city, not the capital" },
  { questionId: 61, transcript: "walz", expected: ["correct"], why: "governor, surname" },
  { questionId: 61, transcript: "Tim Walz", expected: ["correct"], why: "governor, full name" },
  { questionId: 61, transcript: "Tim Waltz", expected: ["correct"], why: "common speech-recognition spelling" },
  { questionId: 61, transcript: "tim walls", expected: ["wrong"], offline: ["correct"], why: "phonetic match; the offline matcher credits it, the strict model does not (false rejection)" },
  { questionId: 61, transcript: "Klobuchar", expected: ["wrong"], why: "a senator, not the governor" },
  { questionId: 23, transcript: "Amy Klobuchar", expected: ["correct"], why: "senator" },
  { questionId: 23, transcript: "um I think it's Klobuchar", expected: ["correct"], why: "filler" },
  { questionId: 23, transcript: "amy globe char", expected: ["wrong"], offline: ["correct"], why: "mangled name; offline phonetic + glued tokens credit it, the model does not (false rejection)" },
  { questionId: 23, transcript: "Tina Smith", expected: ["correct"], why: "senator" },
  { questionId: 23, transcript: "Tim Walz", expected: ["wrong"], why: "the governor, not a senator" },
  { questionId: 29, transcript: "Kelly Morrison", expected: ["correct"], why: "representative, MN-3" },
  { questionId: 29, transcript: "Morrison", expected: ["correct"], why: "surname" },
  { questionId: 29, transcript: "Dean Phillips", expected: ["wrong"], why: "the previous MN-3 representative" },
];

/** Other realistic answers: filler, numbers, multi-item lists, near misses. */
export const GENERAL_CASES: GradingCase[] = [
  { questionId: 126, transcript: "Labor Day, Christmas and Thanksgiving", expected: ["correct"], offline: ["correct"], why: "three holidays, 'Day' optional; credited since the GPU-distilled model" },
  { questionId: 126, transcript: "labor day christmas thanksgiving", expected: ["correct"], why: "no separators at all" },
  { questionId: 126, transcript: "Christmas, Christmas and Christmas", expected: ["wrong"], why: "one holiday three times" },
  { questionId: 126, transcript: "Christmas and Thanksgiving", expected: ["wrong"], why: "two of three" },
  { questionId: 126, transcript: "New Year's, Juneteenth, and Veterans Day", expected: ["correct"], why: "apostrophes, optional 'Day'" },
  { questionId: 2, transcript: "um I think it's the constitution", expected: ["correct"], why: "filler stripped" },
  { questionId: 2, transcript: "the U.S. Constitution", expected: ["correct"], why: "U.S. prefix" },
  { questionId: 2, transcript: "the Declaration of Independence", expected: ["wrong"], why: "a different document" },
  { questionId: 7, transcript: "twenty seven", expected: ["correct"], why: "number words" },
  { questionId: 7, transcript: "27", expected: ["correct"], why: "digits" },
  { questionId: 7, transcript: "twenty six", expected: ["wrong"], why: "off by one" },
  { questionId: 24, transcript: "four hundred thirty five", expected: ["correct"], why: "compound number words" },
  { questionId: 21, transcript: "a hundred", expected: ["correct"], offline: ["correct"], why: "'a hundred' for One hundred (100); credited since the GPU-distilled model" },
  { questionId: 79, transcript: "July 4th 1776", expected: ["correct"], offline: ["correct"], why: "ordinal digits; credited since the GPU-distilled model" },
  { questionId: 79, transcript: "the fourth of July seventeen seventy six", expected: ["correct"], why: "spoken date and year" },
  { questionId: 79, transcript: "July 4th 1777", expected: ["wrong"], why: "wrong year" },
  { questionId: 102, transcript: "nineteen twenty", expected: ["correct"], why: "spoken year" },
  { questionId: 102, transcript: "after world war two", expected: ["wrong"], why: "listed answer is after World War I" },
  { questionId: 102, transcript: "after World War One", expected: ["correct"], offline: ["correct"], why: "World War I spoken out; credited since the GPU-distilled model" },
  { questionId: 37, transcript: "because of the twenty second amendment", expected: ["correct"], why: "spoken ordinal" },
  { questionId: 37, transcript: "the 22nd amendment", expected: ["correct"], why: "digit ordinal" },
  { questionId: 98, transcript: "the 14th amendment", expected: ["wrong"], why: "that is citizenship; voting is the 15th" },
  { questionId: 78, transcript: "Jefferson", expected: ["correct"], why: "surname only" },
  { questionId: 78, transcript: "thomas jeffersen", expected: ["correct"], why: "one-letter misspelling" },
  { questionId: 78, transcript: "George Washington", expected: ["wrong"], why: "wrong founder" },
  { questionId: 107, transcript: "eisen hour was president during the korean war", expected: ["correct"], why: "listed answer; name not needed" },
  { questionId: 105, transcript: "Franklin Roosevelt", expected: ["correct"], why: "listed" },
  { questionId: 105, transcript: "Roosevelt", expected: ["correct"], why: "optional first name" },
  { questionId: 105, transcript: "Truman", expected: ["wrong"], why: "the next president" },
  { questionId: 81, transcript: "New York, New Jersey, Virginia, Georgia and Maryland", expected: ["correct"], why: "five states; 'new' used twice but each state counted once" },
  { questionId: 81, transcript: "New York, New Jersey, Virginia, Georgia and Florida", expected: ["wrong"], why: "Florida was not one of the 13" },
  { questionId: 65, transcript: "freedom of speech, freedom of religion and the right to bear arms", expected: ["correct"], why: "three rights" },
  { questionId: 48, transcript: "secretary of state and secretary of defense", expected: ["correct"], why: "'Secretary of War (Defense)' alternative" },
  { questionId: 10, transcript: "liberty and equality", expected: ["correct"], why: "two ideas" },
  { questionId: 19, transcript: "the senate and the house", expected: ["correct"], why: "optional '(of Representatives)'" },
  { questionId: 19, transcript: "the house of representatives", expected: ["wrong"], why: "only one of the two parts" },
  { questionId: 52, transcript: "the highest court", expected: ["wrong"], why: "restates the question" },
  { questionId: 108, transcript: "the soviet union", expected: ["correct"], why: "listed" },
  { questionId: 108, transcript: "USSR", expected: ["correct"], why: "short listed answer" },
  { questionId: 119, transcript: "Washington DC", expected: ["correct"], why: "listed" },
  { questionId: 87, transcript: "the Louisiana Purchase", expected: ["correct"], offline: ["correct"], why: "parenthetical alternative; credited since the GPU-distilled model" },
  { questionId: 126, transcript: "Washington's birthday, labor day and memorial day", expected: ["correct"], offline: ["correct"], why: "Presidents Day by its other name; credited since the GPU-distilled model" },
  { questionId: 93, transcript: "Sharpsburg", expected: ["correct"], why: "slash alternative of Antietam/Sharpsburg" },
  { questionId: 36, transcript: "four", expected: ["correct"], why: "'years' optional" },
  { questionId: 36, transcript: "six years", expected: ["wrong"], why: "senator term" },
  { questionId: 113, transcript: "he fought for civil rights", expected: ["correct"], why: "filler pronoun" },
  { questionId: 1, transcript: "republic", expected: ["correct"], why: "listed" },
  { questionId: 1, transcript: "a monarchy", expected: ["wrong"], why: "wrong" },
  { questionId: 117, transcript: "the cherokee", expected: ["correct"], why: "tribe" },
  { questionId: 117, transcript: "Aztec", expected: ["wrong"], why: "not a U.S. tribe" },
];

/**
 * Cases that must hold in both pipelines: known model false-credit traps from
 * ~/civics-grader-model (number guard, noise) and the Minnesota answers.
 */
export const HARD_CASES: GradingCase[] = [
  { questionId: 79, transcript: "july fourth seventeen eighty six", expected: ["wrong"], why: "1786 is not 1776 (number guard)" },
  { questionId: 79, transcript: "um july fourth seventeen eighty six", expected: ["wrong"], claude: ["wrong"], why: "a past model false credit; the strict number guard blocks it" },
  { questionId: 91, transcript: "the war of eighteen twenty", expected: ["wrong"], claude: ["wrong"], why: "1820 is not 1812 (number guard)" },
  { questionId: 91, transcript: "the war of twelve hundred", expected: ["wrong"], claude: ["wrong"], why: "a past model false credit; 1200 is not 1812" },
  { questionId: 91, transcript: "war of eighteen twelve", expected: ["correct"], why: "spoken year matches 1812" },
  { questionId: 91, transcript: "the War of 1812", expected: ["correct"], why: "digits" },
  { questionId: 78, transcript: "apple mattocks", expected: ["unintelligible", "wrong"], claude: ["unintelligible"], why: "never rescued into Jefferson" },
  { questionId: 101, transcript: "apple mattocks and uh ship situations", expected: ["wrong", "unintelligible"], claude: ["unintelligible"], why: "noise is never credited" },
  { questionId: 61, transcript: "amy klobuchar", expected: ["wrong"], why: "a senator, not the governor" },
  { questionId: 23, transcript: "Klobuchar", expected: ["correct"], why: "senator, surname" },
  { questionId: 23, transcript: "walz", expected: ["wrong"], why: "the governor, not a senator" },
  { questionId: 62, transcript: "minneapolis", expected: ["wrong"], why: "not the capital" },
  { questionId: 29, transcript: "morrison", expected: ["correct"], why: "representative, surname" },
];

/** The model can say `risky` (counts on the exam, does not advance mastery). The offline tiers cannot. */
export const RISKY_CASES: GradingCase[] = [
  { questionId: 20, transcript: "um Congress has the power to like make rules that everyone has to follow in the country", expected: ["risky"], offline: ["wrong"], claude: ["risky"], why: "paraphrase of 'Writes laws'" },
  { questionId: 64, transcript: "it's the people with citizenship in america basically", expected: ["risky", "correct"], offline: ["wrong"], claude: ["risky"], why: "paraphrase of 'Citizens'; Claude says risky, the GPU-distilled model says correct; both give credit" },
];

/** Noise: nothing gradeable was heard. */
export const NOISE_CASES: GradingCase[] = [
  { questionId: 2, transcript: "", expected: ["unintelligible"], why: "empty" },
  { questionId: 2, transcript: "   ", expected: ["unintelligible"], why: "whitespace" },
  { questionId: 2, transcript: "um", expected: ["unintelligible"], why: "filler" },
  { questionId: 2, transcript: "uh, uh... hmm", expected: ["unintelligible"], why: "filler and punctuation" },
  { questionId: 2, transcript: "?!", expected: ["unintelligible"], why: "punctuation only" },
];

export const ALL_CASES: GradingCase[] = [
  ...MODEL_EVAL_CASES,
  ...VERIFY_CASES,
  ...MINNESOTA_CASES,
  ...GENERAL_CASES,
  ...HARD_CASES,
  ...RISKY_CASES,
  ...NOISE_CASES,
];
