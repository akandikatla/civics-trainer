#!/usr/bin/env node
/**
 * Bundle pre-recorded officer audio into public/audio/.
 *
 * Runs as `prebuild`. Enumerates every line the app can speak from a fixed set
 * (all question texts, feedback lines including the Minnesota answers, greetings,
 * exam closings, mastery counts), computes each line's cache key exactly the way
 * the original app's lib/tts.ts did:
 *
 *   sha256(`Matthew|generative|${clean(text)}`).hex.slice(0, 32) + ".mp3"
 *   clean = collapse whitespace, trim, slice(0, 2800)
 *
 * and copies the matching mp3s from the original app's Polly cache
 * (~/civics-study/audio-cache, override with CIVICS_AUDIO_SRC). Then it writes
 * public/audio/manifest.json mapping clean(text) -> filename for every line whose
 * audio is present.
 *
 * If the source directory is missing the copy step is skipped and whatever is
 * already in public/audio is kept, so a checkout builds without ~/civics-study.
 * Lines without audio are spoken by the browser's speechSynthesis at runtime.
 *
 * The line list here must match lib/engine.ts allSpokenLines(); a vitest test
 * (lib/spoken-lines.test.ts) enforces that.
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VOICE = "Matthew";
const ENGINE = "generative";
const MAX_CHARS = 2800;
const EXAM_PASS_MARK = 12;

export const clean = (text) => text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);

export function cacheKey(text) {
  return createHash("sha256").update(`${VOICE}|${ENGINE}|${clean(text)}`).digest("hex").slice(0, 32);
}

const isPlaceholderAnswer = (a) => {
  const s = a.trim().toLowerCase();
  return s.startsWith("visit uscis.gov") || s.startsWith("answers will vary");
};
const needsLocalAnswers = (answers) => answers.length > 0 && answers.every(isPlaceholderAnswer);

function resolveAnswers(question, local) {
  const answers = local.answers?.[String(question.id)];
  if (answers?.length) return answers;
  return needsLocalAnswers(question.answers) ? null : question.answers;
}

/**
 * Every fixed line, split into `core` (questions, feedback, greetings: these are
 * what the original app pre-warmed) and `dynamic` (counts and corrections, which
 * usually have no recording and fall back to the browser voice).
 */
export function enumerateLines(questions, local) {
  const pool = questions.filter((q) => resolveAnswers(q, local) !== null);
  const starred = pool.filter((q) => q.starred);
  const core = new Set();
  const dynamic = new Set();

  for (const q of pool) core.add(q.question);
  core.add("Correct.");
  core.add("I did not catch that.");
  for (const q of pool) {
    const first = resolveAnswers(q, local)[0];
    if (!first) continue;
    core.add(`That would likely be accepted. The official wording is ${first}.`);
    core.add(`That is not correct. One accepted answer is ${first}.`);
  }
  core.add("Good morning. This is the civics portion of your naturalization interview.");
  core.add("Starting a practice drill on your weakest questions.");
  core.add(`Starting a full pass through all ${pool.length} questions.`);
  core.add(`Starting a full pass through all ${starred.length} questions.`);
  core.add("Everything in this set is already mastered. Well done.");

  dynamic.add("With that correction, you have passed the civics test.");
  dynamic.add("With that correction, the interview continues.");
  dynamic.add(`You answered ${EXAM_PASS_MARK} correctly, so you have passed the civics test.`);
  for (let correct = 0; correct < EXAM_PASS_MARK; correct++) {
    dynamic.add(
      `That is the end. You answered ${correct} of ${correct + 9} correctly, and ${EXAM_PASS_MARK} are needed to pass.`,
    );
  }
  for (let m = 0; m <= pool.length; m++) dynamic.add(`You have mastered ${m} of ${pool.length} questions.`);

  for (const line of core) dynamic.delete(line);
  return { core: [...core], dynamic: [...dynamic] };
}

function main() {
  const questions = JSON.parse(readFileSync(join(ROOT, "data/questions.json"), "utf8"));
  const local = JSON.parse(readFileSync(join(ROOT, "data/local-answers.json"), "utf8"));
  const src = process.env.CIVICS_AUDIO_SRC || join(homedir(), "civics-study", "audio-cache");
  const outDir = join(ROOT, "public", "audio");
  mkdirSync(outDir, { recursive: true });

  const { core, dynamic } = enumerateLines(questions, local);
  const all = [...core, ...dynamic];
  const haveSource = existsSync(src);
  if (!haveSource) console.log(`[bundle-audio] source ${src} not found; keeping existing public/audio`);

  const needed = new Map(); // filename -> clean(text)
  let copied = 0;
  for (const line of all) {
    const file = `${cacheKey(line)}.mp3`;
    needed.set(file, clean(line));
    if (!haveSource) continue;
    const from = join(src, file);
    const to = join(outDir, file);
    if (!existsSync(from)) continue;
    if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
    copyFileSync(from, to);
    copied += 1;
  }

  // Unreferenced recordings can never be played; drop them to keep the site small.
  let pruned = 0;
  for (const name of readdirSync(outDir)) {
    if (name.endsWith(".mp3") && !needed.has(name)) {
      unlinkSync(join(outDir, name));
      pruned += 1;
    }
  }

  const manifest = {};
  const missing = { core: [], dynamic: [] };
  for (const [kind, lines] of [["core", core], ["dynamic", dynamic]]) {
    for (const line of lines) {
      const file = `${cacheKey(line)}.mp3`;
      if (existsSync(join(outDir, file))) manifest[clean(line)] = file;
      else missing[kind].push(line);
    }
  }
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(sorted, null, 1)}\n`);

  const coreHave = core.length - missing.core.length;
  const dynHave = dynamic.length - missing.dynamic.length;
  console.log(
    `[bundle-audio] core lines: ${coreHave}/${core.length} covered; dynamic lines: ${dynHave}/${dynamic.length} covered; ` +
      `copied ${copied}, pruned ${pruned}, manifest entries ${Object.keys(sorted).length}`,
  );
  if (missing.core.length) {
    console.log(`[bundle-audio] core lines without audio (browser voice will speak them):`);
    for (const line of missing.core) console.log(`  - ${line}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
