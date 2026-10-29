#!/usr/bin/env node
/**
 * Copy the onnxruntime-web WebAssembly binary and its JavaScript glue
 * (`.wasm` + `.mjs`) into public/ort/, so the site serves them itself instead of
 * onnxruntime-web / Transformers.js fetching them from a CDN. Runs as part of
 * `prebuild` and `predev`. (With env.wasm.wasmPaths set, onnxruntime-web imports
 * the glue from that folder rather than using the copy embedded in its bundle.)
 *
 * The file is taken from the installed onnxruntime-web (the exact version
 * @huggingface/transformers depends on), so the binary always matches the
 * JavaScript glue that is bundled. lib/model-runtime.ts ORT_WASM_FILE names it.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "ort");

// Must match ORT_WASM_FILE in lib/model-runtime.ts.
const runtime = readFileSync(join(ROOT, "lib", "model-runtime.ts"), "utf8");
const wanted = /export const ORT_WASM_FILE = "([^"]+)"/.exec(runtime)?.[1];
if (!wanted) throw new Error("ORT_WASM_FILE not found in lib/model-runtime.ts");

// Neither package exports ./package.json, so find onnxruntime-web the way Node
// would from inside @huggingface/transformers: its nested copy first, then hoisted.
const transformersDir = join(ROOT, "node_modules", "@huggingface", "transformers");
const ortDir = [join(transformersDir, "node_modules", "onnxruntime-web"), join(ROOT, "node_modules", "onnxruntime-web")].find((d) =>
  existsSync(join(d, "package.json")),
);
if (!ortDir) throw new Error("onnxruntime-web is not installed (npm install)");
const ortPkg = join(ortDir, "package.json");
const files = [wanted, wanted.replace(/\.wasm$/, ".mjs")];
const version = JSON.parse(readFileSync(ortPkg, "utf8")).version;

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (!files.includes(f)) unlinkSync(join(OUT, f));
for (const f of files) {
  const src = join(dirname(ortPkg), "dist", f);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(OUT, f));
  console.log(`ort: public/ort/${f} (onnxruntime-web ${version}, ${(statSync(src).size / 1e6).toFixed(2)} MB)`);
}
