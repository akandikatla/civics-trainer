/**
 * In-browser civics answer grader: a distilled cross-encoder (int8 ONNX) run with
 * Transformers.js v3. Mirrors py/rules.py exactly (fast path, unintelligible rule,
 * decide_combined), so the browser verdict equals the evaluated verdict.
 *
 * Pipeline:
 *   1. fastPathMatch (verbatim port of civics-trainer/lib/mastery.ts)  -> correct
 *   2. unintelligible rule (nothing but filler left)                   -> unintelligible
 *   3. one batched forward pass:
 *        pairwise rows  "Question: q Official answer: a_i"  x transcript   (i = 1..N)
 *        listwise row   "Question: q Official answers: 1) a_1 2) a_2 ... Items required: n" x transcript
 *          (only when the shipped model was trained with listwise rows; LISTWISE below)
 *      Each row yields P(no/wrong), P(correct), P(risky), P(unintelligible).
 *      decideCombined() turns them into a verdict with the baked THRESHOLDS.
 *      matchedAnswer is always the top-ranked LISTED answer(s), so the model can
 *      never cite anything that is not on the official list.
 *
 * Returns null when the model cannot be loaded or run, so callers can fall back to
 * the server grader.
 *
 * Serving: put export_gpu/s1_l12_wo8_all/civics-grader/ (or any export_gpu/<variant>/civics-grader/) at `${baseUrl}civics-grader/`, e.g.
 *   configureModel({ baseUrl: "/my-app/models/" })   // -> /my-app/models/civics-grader/...
 */
import { AutoModelForSequenceClassification, AutoTokenizer, env } from "@huggingface/transformers";

export interface Thresholds {
  mode: "pair" | "list" | "and";
  pair?: { tau_c: number; tau_r: number };
  list?: { tau_c: number; tau_r: number };
  tau_u: number;
  /** Block model credit on number conflicts: true/"class" = numberConflict, "strict" = numberConflictStrict. */
  number_guard?: boolean | "class" | "strict" | "strict_or_class";
  /** Temperature fit on val: probabilities are softmax(logits / T). Pairwise and listwise rows differ. */
  temperature?: { pair: number; list: number };
}

// --- baked constants (written by py/bake.py from export/thresholds.json) ---------
// BEGIN BAKED
// from export_gpu/s1_l12_wo8_all/thresholds.json (models/s1_l12_ep3), tuned on val (false credit <= 1% vs Claude majority-of-3)
export const THRESHOLDS: Thresholds = {"mode": "and", "pair": {"tau_c": 0.5, "tau_r": 0.5}, "list": {"tau_c": 0.78, "tau_r": 0.98}, "tau_u": 0.4, "number_guard": "strict", "temperature": {"pair": 1.05, "list": 1.15}};
export const LISTWISE = true;
export const MODEL_ID = "civics-grader";
export const MAX_LENGTH = 256;
// END BAKED

export type ModelVerdict = "correct" | "risky" | "wrong" | "unintelligible";

export interface ModelQuestion {
  question: string;
  answers: string[];
}

export interface ModelGrade {
  verdict: ModelVerdict;
  matchedAnswer: string | null;
  /** Per listed answer, aligned with question.answers. Empty when a rule decided. */
  scores: Array<{ answer: string; correct: number; risky: number; unintelligible: number }>;
  /** Listwise [wrong, correct, risky, unintelligible]; null when a rule decided or not shipped. */
  listwise: number[] | null;
  decidedBy: "fast-path" | "unintelligible-rule" | "model";
}

let baseUrl = "/models/";
let loading: Promise<{ tokenizer: any; model: any }> | null = null;
let active: Thresholds = THRESHOLDS;

/**
 * Point the loader at the folder that contains civics-grader/. Call before first use.
 * `thresholds` overrides the baked THRESHOLDS, for serving an alternate build from
 * export_final/ with the thresholds.json that sits next to it.
 */
export function configureModel(opts: { baseUrl: string; thresholds?: Thresholds }) {
  baseUrl = opts.baseUrl.endsWith("/") ? opts.baseUrl : `${opts.baseUrl}/`;
  active = opts.thresholds ?? THRESHOLDS;
  loading = null;
}

function load() {
  if (!loading) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = baseUrl;
    loading = Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8" }),
    ]).then(([tokenizer, model]) => ({ tokenizer, model }));
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Warm the model (download + session init) ahead of the first answer. */
export async function preloadModel(): Promise<boolean> {
  try {
    await load();
    return true;
  } catch {
    return false;
  }
}

// --- verbatim ports of civics-trainer/lib/mastery.ts ----------------------------
const FAST_PATH_SIMILARITY = 0.9;

function normalizeCore(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function variantsOf(entry: string): string[] {
  const withInner = normalizeCore(entry.replace(/[()]/g, " "));
  const withoutInner = normalizeCore(entry.replace(/\([^)]*\)/g, " "));
  return [...new Set([withInner, withoutInner])].filter((v) => v.length >= 3);
}

function similar(a: string, b: string, threshold: number): boolean {
  if (a === b) return true;
  const left = new Set(a.split(" "));
  const right = new Set(b.split(" "));
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  const union = left.size + right.size - shared;
  return union > 0 && shared / union >= threshold;
}

function isPlaceholderAnswer(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a.startsWith("visit uscis.gov") || a.startsWith("answers will vary");
}

export function fastPathMatch(transcript: string, official: string[], answersRequired: number): string | null {
  if (answersRequired !== 1) return null;
  const targets = variantsOf(transcript);
  if (targets.length === 0) return null;
  for (const entry of official) {
    if (isPlaceholderAnswer(entry)) continue;
    for (const candidate of variantsOf(entry)) {
      for (const target of targets) if (similar(target, candidate, FAST_PATH_SIMILARITY)) return entry;
    }
  }
  return null;
}

// --- unintelligible rule (identical to py/rules.py FILLER) ------------------------
const FILLER = new Set([
  "um", "umm", "uh", "uhh", "uhm", "hmm", "hm", "mm", "mmm", "er", "erm", "ah", "ahh",
  "eh", "oh", "huh", "like", "so", "well", "yeah", "ok", "okay", "the", "a", "i", "you",
  "know", "what", "sorry", "pardon", "wait", "sec",
]);

export function isUnintelligible(transcript: string): boolean {
  const toks = normalizeCore(transcript).split(" ").filter((t) => t && !FILLER.has(t));
  // Digits count: "100" and "435" are real answers.
  return toks.reduce((n, t) => n + t.replace(/[^a-z0-9]/g, "").length, 0) < 2;
}

// --- decision rule (identical to py/rules.py decide_combined) ---------------------
function nthLargest(xs: number[], n: number): number {
  if (xs.length < n) return -1;
  return [...xs].sort((a, b) => b - a)[n - 1];
}

/** Stable descending order of indices, matching Python's sorted(key=-x). */
function orderDesc(xs: number[]): number[] {
  return xs.map((_, i) => i).sort((a, b) => xs[b] - xs[a] || a - b);
}

/**
 * pair level: 2 if >= required listed answers have P(correct) > pair.tau_c,
 *             1 if >= required have P(correct)+P(risky) > pair.tau_r, else 0.
 * list level: 2 if listwise P(correct) > list.tau_c, 1 if P(correct)+P(risky) > list.tau_r, else 0.
 * mode "and" takes the lower level, so credit needs both views to agree.
 * No credit: unintelligible if listwise P(unintelligible) > tau_u (mean pairwise
 * P(unintelligible) when there is no listwise score), else wrong.
 */
export function decideCombined(
  pc: number[], pr: number[], pu: number[], lv: number[] | null,
  answers: string[], answersRequired: number, th: Thresholds = THRESHOLDS,
): { verdict: ModelVerdict; matchedAnswer: string | null } {
  const need = Math.max(1, answersRequired);
  const credit = pc.map((p, i) => p + pr[i]);
  let lp = 0, ll = 0;
  if (th.mode === "pair" || th.mode === "and") {
    const t = th.pair!;
    lp = nthLargest(pc, need) > t.tau_c ? 2 : nthLargest(credit, need) > t.tau_r ? 1 : 0;
  }
  if (th.mode === "list" || th.mode === "and") {
    const t = th.list!;
    ll = lv![1] > t.tau_c ? 2 : lv![1] + lv![2] > t.tau_r ? 1 : 0;
  }
  const level = th.mode === "pair" ? lp : th.mode === "list" ? ll : Math.min(lp, ll);
  if (level === 2) return { verdict: "correct", matchedAnswer: orderDesc(pc).slice(0, need).map((i) => answers[i]).join("; ") };
  if (level === 1) return { verdict: "risky", matchedAnswer: orderDesc(credit).slice(0, need).map((i) => answers[i]).join("; ") };
  const u = lv ? lv[3] : pu.length ? pu.reduce((s, x) => s + x, 0) / pu.length : 0;
  return { verdict: u > th.tau_u ? "unintelligible" : "wrong", matchedAnswer: null };
}

// --- number-consistency guard (identical to py/rules.py numbers_in / number_conflict) ---
const UNITS: Record<string, number> = Object.fromEntries("zero one two three four five six seven eight nine".split(" ").map((w, i) => [w, i]));
const TEENS: Record<string, number> = Object.fromEntries("ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ").map((w, i) => [w, i + 10]));
const TENS: Record<string, number> = {
  ...Object.fromEntries("twenty thirty forty fifty sixty seventy eighty ninety".split(" ").map((w, i) => [w, (i + 2) * 10])),
  twenny: 20, tweny: 20, thurty: 30, fourty: 40, fivety: 50,
};
const ORD_UNITS: Record<string, number> = Object.fromEntries("first second third fourth fifth sixth seventh eighth ninth".split(" ").map((w, i) => [w, i + 1]));
const ORD_TEENS: Record<string, number> = Object.fromEntries("tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth".split(" ").map((w, i) => [w, i + 10]));
const ORD_TENS: Record<string, number> = Object.fromEntries("twentieth thirtieth fortieth fiftieth sixtieth seventieth eightieth ninetieth".split(" ").map((w, i) => [w, (i + 2) * 10]));
const SCALE: Record<string, number> = { hundred: 100, hundreds: 100, hundredth: 100, hundered: 100, thousand: 1000, thousands: 1000, thousandth: 1000 };
const DIGITS = /^(\d+)(st|nd|rd|th|s)?$/;
const WEAK = new Set(["one", "first", "second"]);

function wordValue(w: string): [number, "u" | "t" | "d" | "s", boolean] | null {
  const tables: Array<[Record<string, number>, "u" | "t" | "d", boolean]> = [
    [UNITS, "u", false], [ORD_UNITS, "u", true], [TEENS, "t", false], [ORD_TEENS, "t", true], [TENS, "d", false], [ORD_TENS, "d", true],
  ];
  for (const [table, kind, o] of tables) if (Object.prototype.hasOwnProperty.call(table, w)) return [table[w], kind, o];
  if (Object.prototype.hasOwnProperty.call(SCALE, w)) return [SCALE[w], "s", w.endsWith("th")];
  return null;
}

function parseRun(run: string[]): number[] {
  const chunks: number[] = [], ords: boolean[] = [];
  let cur = 0, total = 0, last: string | null = null;
  for (const w of run) {
    const [v, k, o] = wordValue(w)!;
    if (k === "s") {
      if (v === 100) cur = (cur || 1) * 100;
      else { total += (cur || 1) * v; cur = 0; }
      last = "s";
    } else {
      const fresh = cur === 0 && total === 0;
      const ok = fresh || last === "s" || (k === "u" && last === "d");
      if (!ok) { chunks.push(total + cur); ords.push(false); cur = 0; total = 0; }
      cur += v;
      last = k;
    }
    if (o) { chunks.push(total + cur); ords.push(true); cur = 0; total = 0; last = null; }
  }
  if (cur || total || last !== null) { chunks.push(total + cur); ords.push(false); }
  const out: number[] = [];
  for (let i = 0; i < chunks.length; ) {
    const a = chunks[i];
    if (i + 1 < chunks.length && !ords[i] && a >= 10 && a <= 99 && chunks[i + 1] >= 0 && chunks[i + 1] <= 99) { out.push(a * 100 + chunks[i + 1]); i += 2; }
    else if (i + 1 < chunks.length && !ords[i] && a >= 1 && a <= 9 && chunks[i + 1] >= 10 && chunks[i + 1] <= 99) { out.push(a * 100 + chunks[i + 1]); i += 2; }
    else { out.push(a); i += 1; }
  }
  return out;
}

export function numbersIn(text: string): Set<number> {
  const toks = normalizeCore(text).split(" ");
  const out = new Set<number>();
  let run: string[] = [];
  const flush = () => {
    if (run.length && !(run.length === 1 && WEAK.has(run[0]))) for (const n of parseRun(run)) out.add(n);
    run = [];
  };
  toks.forEach((t, k) => {
    const m = DIGITS.exec(t);
    if (m) { flush(); out.add(parseInt(m[1], 10)); }
    else if (wordValue(t) !== null) run.push(t);
    else if (t === "and" && run.length && Object.prototype.hasOwnProperty.call(SCALE, run[run.length - 1]) && k + 1 < toks.length && wordValue(toks[k + 1]) !== null) { /* "four hundred and thirty five" */ }
    else flush();
  });
  flush();
  return out;
}

const magnitude = (n: number) => (n < 100 ? 0 : n < 1000 ? 1 : 2);

export function numberConflict(transcript: string, cited: string): boolean {
  const a = [...numbersIn(cited)];
  if (!a.length) return false;
  const t = [...numbersIn(transcript)];
  for (const c of new Set(a.map(magnitude))) {
    const tc = t.filter((n) => magnitude(n) === c);
    const ac = new Set(a.filter((n) => magnitude(n) === c));
    if (tc.length && !tc.some((n) => ac.has(n))) return true;
  }
  return false;
}

/**
 * Exact-match variant (shipped): if the cited answer contains numbers, credit requires every
 * one of them to appear in the transcript. "sexton years" (no parseable number) gets no
 * credit on "Six (6) years"; "eighteen twenty" gets none on "War of 1812".
 */
export function numberConflictStrict(transcript: string, cited: string): boolean {
  const a = numbersIn(cited);
  if (!a.size) return false;
  const t = numbersIn(transcript);
  for (const n of a) if (!t.has(n)) return true;
  return false;
}

export function numberConflictMode(transcript: string, cited: string, mode: Thresholds["number_guard"]): boolean {
  if (mode === true || mode === "class") return numberConflict(transcript, cited);
  if (mode === "strict") return numberConflictStrict(transcript, cited);
  if (mode === "strict_or_class") {
    const a = [...numbersIn(cited)];
    return a.length > 0 && (!numbersIn(transcript).has(Math.max(...a)) || numberConflict(transcript, cited));
  }
  return false;
}

export const textA = (question: string, answer: string) => `Question: ${question} Official answer: ${answer}`;

export const listText = (question: string, answers: string[], required: number) =>
  `Question: ${question} Official answers: ${answers.map((a, i) => `${i + 1}) ${a}`).join(" ")} Items required: ${required}`;

function softmaxRows(data: Float32Array, n: number, k: number, T = 1): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = Array.from(data.slice(i * k, i * k + k)).map((x) => x / T);
    const m = Math.max(...row);
    const ex = row.map((x) => Math.exp(x - m));
    const z = ex.reduce((s, x) => s + x, 0);
    out.push(ex.map((x) => x / z));
  }
  return out;
}

async function forward(tokenizer: any, model: any, a: string[], transcript: string, T = 1): Promise<number[][]> {
  const inputs = tokenizer(a, { text_pair: a.map(() => transcript), padding: true, truncation: true, max_length: MAX_LENGTH });
  const { logits } = await model(inputs);
  const [n, k] = logits.dims as number[];
  return softmaxRows(logits.data as Float32Array, n, k, T);
}

/**
 * All per-answer probabilities (one batch over the listed answers) and, if shipped,
 * the listwise probabilities (a second single-row pass). The listwise row is long, so
 * batching it with the short pair rows would pad every pair row to its length.
 */
export async function scoreAll(
  question: ModelQuestion, transcript: string, answersRequired: number,
): Promise<{ pc: number[]; pr: number[]; pu: number[]; lv: number[] | null }> {
  const { tokenizer, model } = await load();
  const T = active.temperature ?? { pair: 1, list: 1 };
  const pairs = await forward(tokenizer, model, question.answers.map((ans) => textA(question.question, ans)), transcript, T.pair);
  const lv = LISTWISE ? (await forward(tokenizer, model, [listText(question.question, question.answers, answersRequired)], transcript, T.list))[0] : null;
  return { pc: pairs.map((x) => x[1]), pr: pairs.map((x) => x[2]), pu: pairs.map((x) => x[3]), lv };
}

export async function modelGrade(
  question: ModelQuestion, transcript: string, answersRequired: number,
): Promise<ModelGrade | null> {
  const fast = fastPathMatch(transcript, question.answers, answersRequired);
  if (fast) return { verdict: "correct", matchedAnswer: fast, scores: [], listwise: null, decidedBy: "fast-path" };
  if (isUnintelligible(transcript)) {
    return { verdict: "unintelligible", matchedAnswer: null, scores: [], listwise: null, decidedBy: "unintelligible-rule" };
  }
  let s: { pc: number[]; pr: number[]; pu: number[]; lv: number[] | null };
  try {
    s = await scoreAll(question, transcript, answersRequired);
  } catch {
    return null;
  }
  let d = decideCombined(s.pc, s.pr, s.pu, s.lv, question.answers, answersRequired, active);
  if (active.number_guard && (d.verdict === "correct" || d.verdict === "risky") && numberConflictMode(transcript, d.matchedAnswer ?? "", active.number_guard)) {
    d = { verdict: "wrong", matchedAnswer: null }; // stated number contradicts the cited answer
  }
  return {
    verdict: d.verdict,
    matchedAnswer: d.matchedAnswer,
    scores: question.answers.map((answer, i) => ({ answer, correct: s.pc[i], risky: s.pr[i], unintelligible: s.pu[i] })),
    listwise: s.lv,
    decidedBy: "model",
  };
}
