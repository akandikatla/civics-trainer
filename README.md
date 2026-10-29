# USCIS Civics Interview Trainer (offline edition)

A spoken mock interview for the **2025 USCIS civics test** (128 questions). An
officer voice reads each question aloud, you answer out loud, and the app grades
your answer right away. It tracks which questions you have mastered over time.

This edition is a plain website. You don't need an account, a key, or a server, and
nothing you say leaves your computer. Grading runs inside the browser, with a small
grading model that the site downloads from itself once (about 35 MB) and keeps.
Your progress is saved in that browser only.

The real test is oral. The officer asks up to 20 questions and stops as soon as you
answer 12 correctly. Reading a PDF trains recognition. This trains recall.

## Using it

1. **Open the link in Google Chrome.** Other browsers work too, but only Chrome
   reliably understands speech. In other browsers, type your answers in the
   "or type it" box. Grading works the same way.
2. **Allow the microphone** when Chrome asks. If you said no by mistake, click the
   microphone icon in the address bar and choose "Allow".
3. Pick a mode. The officer starts talking.

| Mode | What it does |
|---|---|
| **mock interview** | 20 questions drawn like the real test. Stops at 12 correct. |
| **every question** | Endless. All 128 questions in random order. Anything you miss comes back a few questions later. |
| **weakest first** | Works through the questions you know least, until they are all mastered. |
| **the senior 20** | Only the 20 starred questions, for applicants 65 and older with 20 years of residency. |

**Hands-free is on by default.** The microphone turns on when the officer stops
talking, and your answer is submitted when you stop. Untick "hands-free" to hold
the space bar while you talk instead. The microphone is always off while the
officer is speaking, so the app never hears itself.

## How grading works

Grading runs in your browser. The site never contacts another server: the model,
its tokenizer and the onnxruntime WebAssembly files are served by the site itself
(`public/models/`, `public/ort/`). There are no CDN or Hugging Face Hub requests.

Each answer goes through these steps in order. The first one that decides wins:

1. **Exact match.** If what you said is practically the listed wording, it is
   correct.
2. **Nothing heard.** If only filler is left ("um", "uh", "the"), the officer says
   "I did not catch that" and asks again. That attempt isn't counted.
3. **The grading model.** A distilled cross-encoder (MiniLM-L12, int8 ONNX, 32 MB) was
   trained to copy the Claude grader of the original app, by way of a large
   DeBERTa-v3 teacher trained on GPUs. It scores your answer
   against every listed answer and returns correct, **accepted but not the
   official wording** (`risky`), not correct, or "didn't catch that". It is
   deliberately strict, and a number guard sits on top of it: if the answer it
   would credit contains a number, you must have said that number, so "July
   fourth seventeen eighty six" never passes for 1776.
4. **Receipt check.** Any credit must name an answer that is really on the USCIS
   list, or it is turned into not correct.

A `risky` verdict counts on the mock interview but does not move the question
toward mastered, so you see it again until you say it the official way.

On a fresh test set of 2,236 spoken-style answers that no training or tuning
decision ever saw, each graded three times by Claude, the model agrees with
Claude's majority verdict 83.7% of the time (the previous 23.7 MB model: 74.2%).
It gives credit Claude's majority would not give 3.2% of the time (21 of 660),
against 2.4% for a single Claude pass, and it refuses credit Claude would give
14.7% of the time. Most wrong credits are half-right answers, such as the right
item plus a wrong extra claim. The buttons below exist for the refusals.

### First visit, loading, and offline use

- On the first visit the page downloads the model (32 MB) and the onnxruntime
  WebAssembly binary (11.1 MB). A line under the Minnesota note shows "Loading
  grader… (43 MB, first time only)" with progress. On a host that gzips
  responses the transfer is closer to 25 MB (the wasm compresses well, the model
  does not).
- Both files are kept in the browser's Cache Storage, so later visits start in
  well under a second and work without a connection.
- Until the model is ready, answers are graded by the **offline matcher** (below)
  and the verdict says so. If the model can't run at all (a very old browser, no
  WebAssembly, storage blocked), the page says so once and the offline matcher
  does all the grading.
- Grading takes about 0.1 s per answer on a laptop (headless Chrome: median
  104 ms, 95th percentile 249 ms). It runs between turns, never while the
  microphone is listening.

### The offline matcher (fallback)

The matcher compares your words with the official USCIS answer list:

- It ignores filler words ("um", "uh", "I think it's", "the").
- It understands numbers in either form ("twenty seven", "27", "nineteen twenty",
  "22nd").
- It tolerates small spelling slips from speech recognition ("Jeffersen", "Waltz",
  "St Paul") and names that sound alike ("Tim Walls" for "Tim Walz").
- For "name three holidays" style questions, you need to name that many
  *different* answers from the list.

It never says `risky`, and it is strict about numbers: "four years" never passes
for "six years".

It is used only as a fallback. Running it after a model "not correct" was tried
and rejected, because it adds wrong credit. On the same 1,338 answers:

| Pipeline | Agreement with Claude | Wrong credit | Refused credit |
|---|---|---|---|
| model (shipped) | 85.65% | 0.58% (3/514) | 15.41% |
| model, then fuzzy matcher on "not correct" | 85.35% | 5.64% (29/514) | 10.68% |
| offline matcher only (fallback) | 67.86% | 5.25% (27/514) | 37.99% |

The fuzzy fallback adds no agreement and multiplies wrong credit nearly tenfold, so
the model's verdict is final. (This table uses the earlier 1,338-answer set; the
2,236-answer set above is the stricter, never-seen one.) Re-run the comparison with `npm run eval:pipelines`.

### When the grader gets it wrong

Speech recognition sometimes mishears you, and the grader is strict on purpose. If
an answer is marked **not correct** and you think it was fine, two buttons show up
under the verdict:

| Button | Records it as | Effect |
|---|---|---|
| **I said it right** | correct | Counts on the exam and moves the question toward mastered. |
| **Close, but not exact** | accepted, but not the official wording | Counts on the exam, but you'll see the question again until you can say it the official way. |

The correction replaces the original verdict, so the attempt isn't counted twice.
You can correct an answer until you answer the next question. If the transcript on
screen is wrong before you submit, click **that is not what I said** to throw it
away.

A question counts as **mastered** after two correct answers in a row.

## Minnesota answers: re-check before the interview

Eight questions depend on where you live or on who holds an office now. This copy
is filled in for **Minnesota, ZIP 55347 (Eden Prairie, 3rd congressional
district)**, as of **October 2026**:

| # | Question | Accepted answers |
|---|---|---|
| 23 | One of your state's U.S. senators | Amy Klobuchar, Tina Smith |
| 29 | Your U.S. representative | Kelly Morrison |
| 61 | Governor of your state | Tim Walz |
| 62 | Capital of your state | Saint Paul |
| 30 | Speaker of the House | Mike Johnson |
| 38 | President | Donald Trump |
| 39 | Vice President | JD Vance |
| 57 | Chief Justice | John Roberts |

**The November 3, 2026 election may change the governor and one Senate seat**
(Tina Smith is not running for reelection). Before the interview, check every name
above at <https://www.uscis.gov/citizenship/testupdates> and against current
Minnesota sources. The app shows the same reminder on screen.

To update an answer, edit `data/local-answers.json` and rebuild. The officer reads
new names in the browser's own voice, because there is no recording for them.

## Building and deploying

Requires Node 20+.

```bash
npm install
npm test             # unit tests, offline; runs the real model with onnxruntime-node
npm run build        # writes the static site to out/
npx serve out        # try it locally at http://localhost:3000
npm run eval:pipelines   # optional: model vs fuzzy vs offline on ~/civics-grader-model's fresh test set
```

`npm run build` (and `npm run dev`) first runs `scripts/copy-ort.mjs`, which copies
the onnxruntime-web `.wasm` and its `.mjs` glue from `node_modules` into
`public/ort/` so the version always matches the bundled JavaScript.
`next.config.mjs` also points the browser bundle at onnxruntime-web's wasm-only
build (11 MB instead of the 21.6 MB WebGPU build) and strips Transformers.js' unused
Hugging Face Hub and jsDelivr defaults out of the bundle
(`scripts/strip-remote-defaults.cjs`).

`out/` is a complete static site that works on any static host. `npm run build`
also writes `out/.nojekyll`, which GitHub Pages needs so that it serves the
`_next/` folder.

### GitHub Pages (project site)

A project site is served at `https://<user>.github.io/<repo-name>/`, so the build
has to know that path:

```bash
NEXT_PUBLIC_BASE_PATH=/<repo-name> npm run build
```

Then publish the contents of `out/` (including `.nojekyll`) to the branch or
folder that Pages serves, for example a `gh-pages` branch, or `docs/` on `main`
with Pages set to deploy from that folder. All script, style, audio, model and
wasm URLs pick up the prefix. A site served from a domain root needs no
`NEXT_PUBLIC_BASE_PATH`.

The host should serve `.wasm` as `application/wasm` (`npx serve` does). The page
fetches the wasm itself and hands the bytes to onnxruntime, so a host with a
generic content type still works. The site is about 44 MB on disk, most of it the
model and the wasm.

The microphone needs HTTPS, and GitHub Pages provides it. Plain `http://` works
only on `localhost`.

## Officer audio

The officer's lines are pre-recorded mp3s in `public/audio/`, listed in
`public/audio/manifest.json`. `scripts/bundle-audio.mjs` runs before every build.
It lists every line the app can say, looks up each one in the original app's
recording cache (`~/civics-study/audio-cache`, or set `CIVICS_AUDIO_SRC`), copies
the matches, and rewrites the manifest. If that folder doesn't exist, it keeps the
recordings already in `public/audio/`. The repository therefore builds on its own.

Current coverage: all 128 questions, every greeting, and every standard feedback
line have recordings (352 of 369 fixed lines). The browser's built-in en-US voice
speaks the rest:

- the 16 feedback lines that teach a Minnesota or current-officeholder answer
- the "everything mastered" line
- end-of-interview score lines

## Updating the model

The model comes from `~/civics-grader-model` (the distillation project). Its
recommended build is `export_gpu/s1_l12_wo8_all/` (chosen in
`export_gpu/manifest.json`; the previous 23.7 MB model is kept in `.model-backup-r5/`). To ship a new one:

```bash
SRC=~/civics-grader-model/export_gpu/s1_l12_wo8_all/civics-grader
cp -f $SRC/config.json $SRC/tokenizer.json $SRC/tokenizer_config.json \
      $SRC/special_tokens_map.json public/models/civics-grader/
cp -f $SRC/onnx/model_quantized.onnx public/models/civics-grader/onnx/
cp -f ~/civics-grader-model/export/js/grader-model.ts lib/model-grader.ts
npm test && npm run eval:pipelines && npm run build
```

`lib/model-grader.ts` is a verbatim copy, with its thresholds and decision rule
baked in, so always copy it together with the model files it was tuned for. Keep
`@huggingface/transformers` at the version the model project used (3.8.1) so the
browser matches its measured parity. If a new model changes verdicts in
`eval/cases.ts`, update `expected` there only where the change is legitimate,
never toward credit for a case that must not get it.

## Layout

| Path | Purpose |
|---|---|
| `app/page.tsx` | The whole UI. |
| `lib/engine.ts` | One interview turn: start, answer, self-grade correction, stats. |
| `lib/interview.ts` | Session state and question selection. |
| `lib/mastery.ts` | Pure scheduling and mastery math, including `reviseLastVerdict`. |
| `lib/grader.ts` | Grading pipelines (model, offline fallback), receipt rule, spoken feedback lines. |
| `lib/model-grader.ts` | The model's inference and decision rule, copied verbatim from `~/civics-grader-model`. |
| `lib/model-runtime.ts` | Loads the model from this site only: progress, Cache Storage, fallback state. |
| `lib/debug-hook.ts` | `window.__civicsGrade(id, text)` for headless checks, only with `?debug=1`. |
| `lib/fuzzy.ts` | Normalization, edit distance, phonetic keys, multi-item matching. |
| `lib/store.ts` | The bundled question bank, plus progress in `localStorage` (`civics:` keys). |
| `lib/local-answers.ts` | Merges the Minnesota answers over the bank's placeholders. |
| `lib/use-speech.ts` | Microphone input, bundled-audio or browser-voice output, feedback-loop guard. |
| `data/` | `questions.json` (the 128 questions), `local-answers.json` (Minnesota). |
| `public/models/civics-grader/` | The model: `onnx/model_quantized.onnx`, tokenizer, config. |
| `eval/cases.ts` | Shared grading cases with model and offline expectations. |
| `eval/pipelines.ts` | Agreement and wrong-credit comparison of the pipelines (`npm run eval:pipelines`). |
| `scripts/bundle-audio.mjs` | Pre-build audio bundler. |
| `scripts/copy-ort.mjs` | Pre-build copy of the onnxruntime-web wasm into `public/ort/`. |

## Known limits

- Progress lives in this browser on this computer. Clearing site data, or using
  another browser or device, starts from zero. Use **reset progress** at the
  bottom of the page to start over on purpose.
- Reloading the page ends the current session. Mastery is kept.
- The model is strict. It refuses about a third of the answers Claude would
  accept, including some that are close to the official wording ("July 4th
  1776", "Labor Day, Christmas and Thanksgiving", "Tim Walls"). Use **I said it
  right** or **Close, but not exact** for these.
- It still gives wrong credit now and then (about 1 in 60 answers that should
  fail, for example "Carrie Morrison" is accepted for Kelly Morrison).
- `risky` feedback names the listed answer the model matched. Only the line for
  each question's first listed answer has a recording, so others are spoken in
  the browser's voice.
- Speech recognition handles unusual names poorly. Glued or misheard names are
  sometimes recovered, but not always.
