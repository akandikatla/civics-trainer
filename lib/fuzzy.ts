/**
 * Forgiving, offline answer matching.
 *
 * Speech recognition mangles what people say, especially names ("Klobuchar",
 * "Walz", "Eisenhower"), and people answer with filler ("um, I think it's the
 * Constitution"). This module decides, without any model, whether a transcript
 * contains one of the official answers.
 *
 * Pipeline per comparison:
 *   1. normalize: lowercase, strip punctuation, canonicalize "U.S." / "United
 *      States", number words to digits ("twenty seven" -> 27, "nineteen twenty"
 *      -> 1920, "22nd" -> 22), "St." -> saint, "Jr." -> junior.
 *   2. drop filler and function words (um, uh, the, a, it's, I think, ...) from
 *      both sides, symmetrically.
 *   3. expand each official answer into variants: USCIS parentheses mark optional
 *      or alternative wording, slashes mark alternatives.
 *   4. score: every answer token looks for its best match in the transcript, by
 *      exact match (1.0), small edit distance (0.7-0.95), or equal phonetic key
 *      (0.8). Adjacent transcript tokens may be glued together, so "eisen hour"
 *      can stand in for "eisenhower" and "j d" for "jd".
 *   5. the answer is credited when the weighted share of its tokens found in the
 *      transcript clears MATCH_THRESHOLD. Digits are exact-only and mandatory:
 *      "four years" never matches "six years", "world war two" never matches
 *      "World War I".
 *
 * Pure functions only. No I/O.
 */

/** Minimum weighted share of an answer's tokens that must be found. */
export const MATCH_THRESHOLD = 0.75;
/** Score for a token whose phonetic key equals the answer token's key. */
export const PHONETIC_SCORE = 0.8;

/**
 * Words dropped from both answer and transcript before comparing. Symmetric
 * removal is safe: it can only make a listed answer easier to find, never
 * introduce a word that is not there. Negations ("not", "no") are kept.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "and", "or", "is", "are", "was", "were",
  "be", "been", "being", "it", "its", "um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "mm",
  "hm", "oh", "well", "so", "okay", "ok", "yeah", "like", "i", "im", "think", "believe", "guess",
  "maybe", "that", "this", "answer", "would", "say", "probably",
]);

/** Generic words that should not sink a match on their own ("Christmas" for "Christmas Day"). */
const LOW_WEIGHT: Record<string, number> = { day: 0.3, us: 0.3, years: 0.3, year: 0.3 };

const TOKEN_ALIASES: Record<string, string> = {
  st: "saint",
  jr: "junior",
  mt: "mount",
  usa: "us",
};

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30,
  fortieth: 40, fiftieth: 50,
};

/**
 * Convert runs of number words to digit tokens.
 *
 * "four hundred thirty five" -> 435, "twenty second" -> 22, "a hundred" -> 100.
 * Two adjacent two-digit groups read as a year: "nineteen twenty" -> 1920,
 * "seventeen seventy six" -> 1776, "eighteen twelve" -> 1812.
 */
function numberize(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!(t in ONES) && !(t in TENS) && !(t in ORDINALS) && t !== "hundred" && t !== "thousand") {
      out.push(t);
      i += 1;
      continue;
    }

    // Parse one run of number words into one or more groups.
    const groups: Array<{ value: number; scaled: boolean }> = [];
    let cur = 0;
    let total = 0;
    let scaled = false;
    let last: "ones" | "teen" | "tens" | "scale" | null = null;
    let active = false;
    const flush = () => {
      if (active) groups.push({ value: total + cur, scaled });
      cur = 0;
      total = 0;
      scaled = false;
      last = null;
      active = false;
    };

    while (i < tokens.length) {
      const w = tokens[i];
      if (w in ORDINALS) {
        const v = ORDINALS[w];
        if (v < 10 && last === "tens") cur += v;
        else {
          if (last === "ones" || last === "teen" || (last === "tens" && v >= 10)) flush();
          cur += v;
        }
        active = true;
        i += 1;
        break; // an ordinal always ends the number
      }
      if (w in ONES) {
        const v = ONES[w];
        if (last === "ones" || last === "teen" || (last === "tens" && v >= 10)) flush();
        cur += v;
        last = v >= 10 ? "teen" : "ones";
      } else if (w in TENS) {
        if (last === "ones" || last === "teen" || last === "tens") flush();
        cur += TENS[w];
        last = "tens";
      } else if (w === "hundred") {
        cur = (cur || 1) * 100;
        scaled = true;
        last = "scale";
      } else if (w === "thousand") {
        total += (cur || 1) * 1000;
        cur = 0;
        scaled = true;
        last = "scale";
      } else break;
      active = true;
      i += 1;
    }
    flush();

    // Join "nineteen" + "twenty nine" into 1929.
    for (let g = 0; g < groups.length; g++) {
      const a = groups[g];
      const b = groups[g + 1];
      if (b && !a.scaled && !b.scaled && a.value >= 10 && a.value <= 99 && b.value >= 10 && b.value <= 99) {
        out.push(String(a.value * 100 + b.value));
        g += 1;
      } else out.push(String(a.value));
    }
  }
  return out;
}

/** Normalize free text into comparable tokens. Order is preserved. */
export function tokenize(text: string, { keepStopwords = false } = {}): string[] {
  let s = text.toLowerCase();
  s = s.replace(/[‘’ʼ`]/g, "'").replace(/[“”]/g, '"');
  s = s.replace(/\[[^\]]*\]/g, " "); // bracketed USCIS guidance is not part of an answer
  s = s.replace(/\bu\.\s?s\.(\s?a\.)?/g, " us ");
  s = s.replace(/\bunited states( of america)?\b/g, " us ");
  // Roman numerals only where they actually occur in this bank.
  s = s.replace(/\bwar ii\b/g, "war 2").replace(/\bwar i\b/g, "war 1");
  s = s.replace(/&/g, " and ");
  s = s.replace(/['.]/g, ""); // "D.C." -> dc, "year's" -> years, "St." -> st
  s = s.replace(/(\d)(st|nd|rd|th)\b/g, "$1"); // 22nd -> 22
  s = s.replace(/[^a-z0-9]+/g, " ");

  let tokens = s.split(" ").filter(Boolean).map((t) => TOKEN_ALIASES[t] ?? t);
  // Speech output "U S" -> us.
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "u" && tokens[i + 1] === "s") {
      merged.push("us");
      i += 1;
    } else merged.push(tokens[i]);
  }
  tokens = numberize(merged);
  return keepStopwords ? tokens : tokens.filter((t) => !STOPWORDS.has(t));
}

/** Levenshtein edit distance. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * A compact phonetic key in the spirit of Metaphone.
 *
 * Collapses spellings that sound alike: ph/f, ck/k, soft c/s, ch/sh, th, voiced
 * and unvoiced pairs (b/p, d/t, g/k, v/f, z/s), drops vowels after the first
 * letter, drops h/w/y, and collapses repeats. "Walz", "walls" -> WLS;
 * "Klobuchar", "globe char" -> KLPXR; "Eisenhower", "eisen hour" -> ASNR.
 */
export function phoneticKey(word: string): string {
  let s = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "";
  s = s.replace(/^(kn|gn|pn)/, "n").replace(/^wr/, "r").replace(/^ps/, "s").replace(/^wh/, "w").replace(/^x/, "s");
  s = s
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/sch/g, "sk")
    .replace(/tch/g, "X")
    .replace(/ch/g, "X")
    .replace(/sh/g, "X")
    .replace(/th/g, "0")
    .replace(/dg(?=[eiy])/g, "j")
    .replace(/gh(?![aeiouy])/g, "")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/[cq]/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/v/g, "f")
    .replace(/b/g, "p")
    .replace(/d/g, "t")
    .replace(/g/g, "k");

  const first = s[0];
  let key = /[aeiouy]/.test(first) ? "A" : first.toUpperCase();
  for (const ch of s.slice(1)) {
    if (/[aeiouyhw]/.test(ch)) continue;
    key += ch.toUpperCase();
  }
  return key.replace(/(.)\1+/g, "$1");
}

/** Similarity of an answer token to a transcript unit, 0 when not a match. */
export function tokenSimilarity(answer: string, heard: string): number {
  if (answer === heard) return 1;
  // Numbers are exact or nothing: 6 must never pass for 5.
  if (/\d/.test(answer) || /\d/.test(heard)) return 0;

  const shorter = Math.min(answer.length, heard.length);
  const longer = Math.max(answer.length, heard.length);
  const tolerance = shorter <= 3 ? 0 : shorter <= 5 ? 1 : shorter <= 8 ? 2 : 3;
  let best = 0;
  if (tolerance > 0) {
    const d = levenshtein(answer, heard);
    if (d <= tolerance) {
      const sim = 1 - d / longer;
      if (sim >= 0.7) best = Math.min(0.95, sim);
    }
  }

  if (shorter >= 4) {
    const ka = phoneticKey(answer);
    if (ka.length >= 3 && ka === phoneticKey(heard)) best = Math.max(best, PHONETIC_SCORE);
  }
  return best;
}

const OPTIONAL_LEADS = /^(of|for|if|the|a|an|from|during|under|with|until|because|its|it|or|and|to|in|on|at)\b/i;

/**
 * The accepted readings of one official answer string.
 *
 * USCIS parentheses mean several things, all handled:
 *   "(Thomas) Jefferson"            optional words  -> with and without
 *   "Secretary of War (Defense)"    an alternative  -> "Secretary of Defense"
 *   "Presidents Day (Washington's Birthday)"  an alternative name -> the inner text alone
 *   "Antietam/Sharpsburg"           slash alternatives -> each side
 */
export function answerVariants(entry: string): string[] {
  const base = entry.replace(/\[[^\]]*\]/g, " ");
  const out = new Set<string>();
  const add = (s: string) => {
    const v = s.replace(/\s+/g, " ").trim();
    if (v) out.add(v);
  };

  add(base.replace(/[()]/g, " "));
  add(base.replace(/\([^)]*\)/g, " "));

  // A single word in parentheses can replace the word before it.
  add(base.replace(/(\S+)\s*\(([^)\s]+)\)/g, "$2"));

  // A trailing parenthetical that reads as a name of its own ("(Louisiana Purchase)").
  const trailing = base.match(/\(([^)]+)\)\s*\.?\s*$/);
  if (trailing && !OPTIONAL_LEADS.test(trailing[1].trim()) && trailing[1].trim().split(/\s+/).length >= 2) {
    add(trailing[1]);
  }

  for (const v of [...out]) {
    if (!v.includes("/")) continue;
    add(v.replace(/(\S+)\/(\S+)/g, "$1"));
    add(v.replace(/(\S+)\/(\S+)/g, "$2"));
  }
  return [...out];
}

interface Unit {
  text: string;
  positions: number[];
}

/** Transcript tokens plus adjacent pairs and triples glued together. */
function unitsOf(tokens: string[], from: number, to: number): Unit[] {
  const units: Unit[] = [];
  for (let i = from; i < to; i++) {
    units.push({ text: tokens[i], positions: [i] });
    if (i + 1 < to) units.push({ text: tokens[i] + tokens[i + 1], positions: [i, i + 1] });
    if (i + 2 < to) units.push({ text: tokens[i] + tokens[i + 1] + tokens[i + 2], positions: [i, i + 1, i + 2] });
  }
  return units;
}

export interface EntryScore {
  score: number;
  /** Transcript positions used by the match, for keeping multi-item answers distinct. */
  positions: number[];
}

const weightOf = (t: string) => LOW_WEIGHT[t] ?? 1;

/** Score one tokenized answer variant against a window of transcript tokens. */
function scoreTokens(answer: string[], heard: string[], from: number, to: number): EntryScore {
  const unique = [...new Set(answer)];
  if (unique.length === 0) return { score: 0, positions: [] };
  const units = unitsOf(heard, from, to);

  let got = 0;
  let total = 0;
  const used = new Set<number>();
  for (const token of unique) {
    const w = weightOf(token);
    total += w;
    let best = 0;
    let bestUnit: Unit | null = null;
    for (const u of units) {
      const sim = tokenSimilarity(token, u.text);
      if (sim > best) {
        best = sim;
        bestUnit = u;
        if (sim === 1) break;
      }
    }
    // Digits are mandatory: a date or count that is not there sinks the match.
    if (best === 0 && /\d/.test(token)) return { score: 0, positions: [] };
    got += w * best;
    if (bestUnit) bestUnit.positions.forEach((p) => used.add(p));
  }
  return { score: got / total, positions: [...used].sort((a, b) => a - b) };
}

/** Tokenize an answer variant; fall back to stopwords-kept if dropping empties it. */
function answerTokens(variant: string): string[] {
  const t = tokenize(variant);
  return t.length > 0 ? t : tokenize(variant, { keepStopwords: true });
}

const variantCache = new Map<string, string[][]>();
function tokenizedVariants(entry: string): string[][] {
  let v = variantCache.get(entry);
  if (!v) {
    v = answerVariants(entry).map(answerTokens).filter((t) => t.length > 0);
    variantCache.set(entry, v);
  }
  return v;
}

/** Best score of an official answer against a transcript window, across its variants. */
export function scoreEntry(entry: string, heard: string[], from = 0, to = heard.length): EntryScore {
  let best: EntryScore = { score: 0, positions: [] };
  for (const variant of tokenizedVariants(entry)) {
    const s = scoreTokens(variant, heard, from, to);
    if (s.score > best.score) best = s;
  }
  return best;
}

export interface MatchResult {
  /** Official answers credited, in the order they were found. */
  matched: string[];
  /** Weakest score among the credited answers (1 = exact). */
  score: number;
}

/**
 * Find `required` distinct official answers in the transcript.
 *
 * For a single-answer question the whole transcript is the window, so filler and
 * extra words never hurt. For multi-item questions ("name three holidays") each
 * answer is looked for in short windows, and the credited answers must use
 * non-overlapping parts of the transcript, so one phrase cannot count twice and
 * "Christmas, Christmas, Christmas" is one holiday. Separators are optional:
 * speech recognition often drops commas entirely.
 */
export function findAnswers(transcript: string, official: string[], required: number): MatchResult | null {
  const heard = tokenize(transcript);
  if (heard.length === 0) return null;

  if (required <= 1) {
    let best: { entry: string; score: number } | null = null;
    for (const entry of official) {
      const { score } = scoreEntry(entry, heard);
      if (score >= MATCH_THRESHOLD && (!best || score > best.score)) best = { entry, score };
    }
    return best ? { matched: [best.entry], score: best.score } : null;
  }

  // Candidate windows per entry.
  type Candidate = { positions: number[]; score: number };
  const candidates = new Map<number, Candidate[]>();
  official.forEach((entry, index) => {
    const maxLen = Math.max(...tokenizedVariants(entry).map((v) => v.length), 1) + 2;
    const seen = new Set<string>();
    const list: Candidate[] = [];
    for (let from = 0; from < heard.length; from++) {
      for (let len = 1; len <= maxLen && from + len <= heard.length; len++) {
        const s = scoreEntry(entry, heard, from, from + len);
        if (s.score < MATCH_THRESHOLD) continue;
        const key = s.positions.join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        list.push({ positions: s.positions, score: s.score });
      }
    }
    if (list.length) candidates.set(index, list.sort((a, b) => b.score - a.score));
  });

  // Maximum set of entries with pairwise-disjoint transcript positions (small DFS).
  const entries = [...candidates.keys()].sort((a, b) => candidates.get(a)!.length - candidates.get(b)!.length);
  let best: Array<{ index: number; score: number }> = [];
  const chosen: Array<{ index: number; score: number }> = [];
  const claimed = new Set<number>();
  let budget = 20_000;

  const search = (k: number) => {
    if (chosen.length > best.length) best = [...chosen];
    if (best.length >= required || k >= entries.length || budget-- <= 0) return;
    if (chosen.length + (entries.length - k) <= best.length) return;
    const index = entries[k];
    for (const c of candidates.get(index)!) {
      if (c.positions.some((p) => claimed.has(p))) continue;
      c.positions.forEach((p) => claimed.add(p));
      chosen.push({ index, score: c.score });
      search(k + 1);
      chosen.pop();
      c.positions.forEach((p) => claimed.delete(p));
      if (best.length >= required) return;
    }
    search(k + 1);
  };
  search(0);

  if (best.length < required) return null;
  const picked = best.slice(0, required).sort((a, b) => a.index - b.index);
  return { matched: picked.map((p) => official[p.index]), score: Math.min(...picked.map((p) => p.score)) };
}

/** True when the transcript has no content at all once filler is removed. */
export function isNoise(transcript: string): boolean {
  return tokenize(transcript).length === 0;
}
