/**
 * Compare grading pipelines against Claude's majority verdicts.
 *
 *   npm run eval:pipelines [-- path/to/examples_test_final.jsonl]
 *
 * Default input: ~/civics-grader-model/data/examples_test_final.jsonl, the fresh
 * test set (1338 transcripts, up to 3 Claude grades each, never used for any
 * decision in the model project). Read only.
 *
 * Pipelines, all through this site's own grade() (so the receipt rule applies):
 *   model        exact -> model (unintelligible rule, model, number guard), as in REPORT.md
 *   model+fuzzy  same, but a model `wrong` is handed to the fuzzy tier
 *   offline      intelligibility -> exact -> fuzzy (the fallback while the model loads)
 *
 * Metrics follow py/evaluate.py: 4-way agreement, false credit = share of
 * non-credit majority rows given credit (correct/risky), false rejection = share
 * of credit rows not given credit.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MODEL_FUZZY_TIERS, MODEL_TIERS, OFFLINE_TIERS, grade, type GradingTier } from "../lib/grader";
import { countRequired, type Question } from "../lib/mastery";
import { loadModelGrader } from "../lib/model-runtime";
import { loadQuestions } from "../lib/store";
import { withResolvedAnswers } from "../lib/local-answers";

type V = "correct" | "risky" | "wrong" | "unintelligible";
const CREDIT = new Set<V>(["correct", "risky"]);
const V4: V[] = ["correct", "risky", "wrong", "unintelligible"];

interface Row {
  key: string;
  text: string;
  verdict: V;
  majority?: V;
}

const file = process.argv[2] ?? join(homedir(), "civics-grader-model", "data", "examples_test_final.jsonl");
const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function metrics(ys: V[], ps: V[]) {
  const n = ys.length;
  let agree = 0, fc = 0, neg = 0, fr = 0, pos = 0;
  const conf: Record<V, Record<V, number>> = Object.fromEntries(V4.map((a) => [a, Object.fromEntries(V4.map((b) => [b, 0]))])) as never;
  ys.forEach((y, i) => {
    const p = ps[i];
    conf[y][p] += 1;
    if (y === p) agree += 1;
    if (CREDIT.has(y)) {
      pos += 1;
      if (!CREDIT.has(p)) fr += 1;
    } else {
      neg += 1;
      if (CREDIT.has(p)) fc += 1;
    }
  });
  const credit = ys.filter((y, i) => CREDIT.has(y) === CREDIT.has(ps[i])).length;
  return { n, agreement: agree / n, credit_agreement: credit / n, false_credit: fc / neg, fc, neg, false_rejection: fr / pos, fr, pos, conf };
}

const pct = (x: number) => `${(100 * x).toFixed(2)}%`;

async function main() {
  const ok = await loadModelGrader({ modelBaseUrl: resolve(__dirname, "..", "public", "models") });
  if (!ok) throw new Error("model failed to load");

  const bank = new Map(loadQuestions().map((q) => [String(q.id), withResolvedAnswers(q)]));
  const usable = rows.filter((r) => bank.has(r.key));
  console.log(`rows: ${rows.length}, gradeable here: ${usable.length} (file ${file})`);

  const pipelines: Array<[string, GradingTier[]]> = [
    ["model", MODEL_TIERS],
    ["model+fuzzy", MODEL_FUZZY_TIERS],
    ["offline", OFFLINE_TIERS],
  ];
  const preds: Record<string, V[]> = {};
  const fuzzyRescues: Array<{ key: string; text: string; majority: V; matched: string | null }> = [];
  for (const [name, tiers] of pipelines) {
    const out: V[] = [];
    const t0 = performance.now();
    for (const r of usable) {
      const q = bank.get(r.key) as Question;
      const g = await grade(q, r.text, countRequired(q.question), tiers);
      out.push(g.verdict as V);
      if (name === "model+fuzzy" && g.tier === "fuzzy") fuzzyRescues.push({ key: r.key, text: r.text, majority: (r.majority ?? r.verdict) as V, matched: g.matchedAnswer });
    }
    preds[name] = out;
    console.log(`${name}: graded in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }

  for (const ref of ["majority", "verdict"] as const) {
    console.log(`\nagainst ${ref === "majority" ? "majority of 3 Claude samples" : "the original single Claude label"}:`);
    console.log("| pipeline | n | agreement (4-way) | credit yes/no | false credit | false rejection |");
    console.log("|---|---|---|---|---|---|");
    const ys = usable.map((r) => (r[ref] ?? r.verdict) as V);
    for (const [name] of pipelines) {
      const m = metrics(ys, preds[name]);
      console.log(`| ${name} | ${m.n} | ${pct(m.agreement)} | ${pct(m.credit_agreement)} | ${pct(m.false_credit)} (${m.fc}/${m.neg}) | ${pct(m.false_rejection)} (${m.fr}/${m.pos}) |`);
    }
  }

  const changed = usable.map((r, i) => ({ r, a: preds.model[i], b: preds["model+fuzzy"][i] })).filter((x) => x.a !== x.b);
  console.log(`\nmodel vs model+fuzzy: ${changed.length} rows differ (fuzzy rescued ${fuzzyRescues.length})`);
  for (const x of fuzzyRescues) {
    const flag = CREDIT.has(x.majority) ? "ok   " : "FALSE";
    console.log(`  ${flag} Q${x.key} majority=${x.majority} "${x.text}" -> ${x.matched}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
