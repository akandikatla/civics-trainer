/**
 * Loads and runs the distilled grading model (lib/model-grader.ts) without ever
 * touching the network beyond this site's own origin.
 *
 * - The model lives in public/models/civics-grader/ and the onnxruntime-web
 *   WebAssembly binary in public/ort/. Both are served by the static site.
 * - Transformers.js is told to use local files only (no Hugging Face Hub) and
 *   onnxruntime-web is told where the wasm lives (no CDN).
 * - Loading is lazy and in the background. Until it finishes, or if it fails
 *   (old browser, no WebAssembly, storage blocked), `isModelReady()` is false and
 *   lib/grader.ts grades with the offline tiers instead.
 * - The two large files are fetched here with progress and kept in the browser's
 *   Cache Storage, so the download happens once. The model file is stored under
 *   the exact key Transformers.js looks up (`transformers-cache`, local path), so
 *   Transformers.js reads it straight from the cache.
 *
 * lib/model-grader.ts is a verbatim copy of ~/civics-grader-model/export/js and
 * is only reached through a dynamic import here, so Transformers.js stays out of
 * the main bundle and out of the static prerender.
 */

import type { ModelGrade, ModelQuestion } from "./model-grader";

export type ModelStatus = "idle" | "loading" | "ready" | "failed";

export interface ModelState {
  status: ModelStatus;
  /** While loading: fetching the files, or starting the runtime once they are here. */
  phase?: "download" | "init";
  /** Bytes fetched so far across the model and wasm files (0 when unknown). */
  loaded: number;
  /** Expected total bytes (0 until the sizes are known). */
  total: number;
  /** True when both large files came from the browser cache. */
  fromCache: boolean;
  error?: string;
}

export interface LoadOptions {
  /** Folder that contains civics-grader/. Browser: URL path. Node: file system path. */
  modelBaseUrl?: string;
  /** Folder that contains the onnxruntime-web .wasm file (browser only). */
  wasmBaseUrl?: string;
}

/** Same variable next.config.mjs uses; "" at the site root. */
const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

export const MODEL_DIR = "civics-grader";
export const MODEL_FILE = "onnx/model_quantized.onnx";
/**
 * The binary matching the onnxruntime-web build in the browser bundle
 * (next.config.mjs aliases it to onnxruntime-web/wasm). scripts/copy-ort.mjs
 * copies this file and its .mjs glue into public/ort/.
 */
export const ORT_WASM_FILE = "ort-wasm-simd-threaded.wasm";
/**
 * First-time download for the loading line: model 32.0 MB + onnxruntime wasm
 * 11.1 MB. Later visits read both from Cache Storage.
 */
export const APPROX_DOWNLOAD_MB = 43;

const TRANSFORMERS_CACHE = "transformers-cache";
const RUNTIME_CACHE = "civics-grader-runtime";

type ModelModule = typeof import("./model-grader");

let state: ModelState = { status: "idle", loaded: 0, total: 0, fromCache: false };
const listeners = new Set<(s: ModelState) => void>();
let loading: Promise<boolean> | null = null;
let mod: ModelModule | null = null;

function setState(patch: Partial<ModelState>) {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

export const getModelState = (): ModelState => state;
export const isModelReady = (): boolean => state.status === "ready" && mod !== null;

export function subscribeModel(fn: (s: ModelState) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => void listeners.delete(fn);
}

const isBrowser = () => typeof window !== "undefined" && typeof document !== "undefined";
const withSlash = (s: string) => (s.endsWith("/") ? s : `${s}/`);

/** Can this browser run the model at all? */
function supported(): string | null {
  if (typeof WebAssembly !== "object" || typeof WebAssembly.instantiate !== "function") return "WebAssembly is not available";
  if (typeof fetch !== "function") return "fetch is not available";
  return null;
}

async function openCache(name: string): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(name);
  } catch {
    return null; // e.g. some private modes refuse Cache Storage
  }
}

/**
 * Fetch one same-origin file with byte progress, through Cache Storage.
 * Returns the bytes; stores them under `key` for next time.
 */
async function fetchCached(
  url: string,
  cache: Cache | null,
  key: string,
  onBytes: (loaded: number, total: number) => void,
): Promise<{ bytes: Uint8Array; cached: boolean; headers: Headers }> {
  const hit = cache ? await cache.match(key) : undefined;
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onBytes(bytes.byteLength, bytes.byteLength);
    return { bytes, cached: true, headers: hit.headers };
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  // With Content-Encoding (gzip/br from the host) content-length is the compressed
  // size but the stream yields decompressed bytes, so the total is unknown.
  const encoding = (res.headers.get("content-encoding") ?? "identity").toLowerCase();
  const total = encoding === "identity" ? Number(res.headers.get("content-length") ?? 0) : 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onBytes(loaded, total > 0 ? Math.max(total, loaded) : 0);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  if (cache) {
    const headers = new Headers({ "content-type": res.headers.get("content-type") ?? "application/octet-stream" });
    await cache.put(key, new Response(bytes, { headers })).catch(() => {
      /* quota: still usable this session, just not cached */
    });
  }
  return { bytes, cached: false, headers: res.headers };
}

async function loadInBrowser(opts: LoadOptions): Promise<void> {
  const modelBase = withSlash(opts.modelBaseUrl ?? `${BASE_PATH}/models/`);
  const wasmBase = withSlash(opts.wasmBaseUrl ?? `${BASE_PATH}/ort/`);
  const abs = (p: string) => new URL(p, window.location.href).href;

  // Fetch the two large files first, with progress, before Transformers.js runs.
  const modelUrl = `${modelBase}${MODEL_DIR}/${MODEL_FILE}`;
  const wasmUrl = `${wasmBase}${ORT_WASM_FILE}`;
  const [tfCache, rtCache] = await Promise.all([openCache(TRANSFORMERS_CACHE), openCache(RUNTIME_CACHE)]);
  const progress = { model: [0, 0], wasm: [0, 0] };
  // Totals only once both responses have reported a size, so the percentage never
  // runs ahead (cache hits report at once; compressed responses never do).
  const report = () => {
    const known = progress.model[1] > 0 && progress.wasm[1] > 0;
    setState({
      phase: "download",
      loaded: progress.model[0] + progress.wasm[0],
      total: known ? progress.model[1] + progress.wasm[1] : 0,
    });
  };
  const [m, w] = await Promise.all([
    // Key = the path Transformers.js itself will look up in `transformers-cache`.
    fetchCached(modelUrl, tfCache, modelUrl, (l, t) => ((progress.model = [l, t]), report())),
    fetchCached(wasmUrl, rtCache, abs(wasmUrl), (l, t) => ((progress.wasm = [l, t]), report())),
  ]);
  setState({ phase: "init", fromCache: m.cached && w.cached });

  const tf = await import("@huggingface/transformers");
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = modelBase;
  tf.env.useBrowserCache = tfCache !== null;
  const wasm = tf.env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = abs(wasmBase); // never the jsDelivr default
    wasm.wasmBinary = w.bytes; // already fetched; onnxruntime-web skips its own fetch
    wasm.proxy = false;
  }

  mod = await import("./model-grader");
  mod.configureModel({ baseUrl: modelBase });
}

async function loadInNode(opts: LoadOptions): Promise<void> {
  if (!opts.modelBaseUrl) throw new Error("modelBaseUrl (a folder containing civics-grader/) is required outside the browser");
  const tf = await import("@huggingface/transformers");
  tf.env.allowRemoteModels = false;
  tf.env.allowLocalModels = true;
  tf.env.localModelPath = withSlash(opts.modelBaseUrl);
  tf.env.useBrowserCache = false;
  tf.env.useFSCache = false;
  mod = await import("./model-grader");
  mod.configureModel({ baseUrl: withSlash(opts.modelBaseUrl) });
}

/**
 * Start loading (idempotent). Resolves true when the model is ready to grade,
 * false when it cannot be used on this device. Never rejects.
 */
export function loadModelGrader(opts: LoadOptions = {}): Promise<boolean> {
  if (loading) return loading;
  loading = (async () => {
    const unsupported = supported();
    if (unsupported) {
      setState({ status: "failed", error: unsupported });
      return false;
    }
    setState({ status: "loading", phase: "download", error: undefined });
    try {
      await (isBrowser() ? loadInBrowser(opts) : loadInNode(opts));
      if (!(await mod!.preloadModel())) throw new Error("the model failed to initialise");
      // One throwaway pass so the first real answer does not pay session warm-up.
      await mod!.scoreAll({ question: "Warm-up?", answers: ["warm up"] }, "warm up", 1).catch(() => undefined);
      setState({ status: "ready", phase: undefined });
      return true;
    } catch (err) {
      mod = null;
      setState({ status: "failed", error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  })();
  return loading;
}

/**
 * Grade with the model pipeline (fast path, unintelligible rule, model with the
 * number guard). Null when the model is not loaded or the run failed.
 */
export async function runModel(question: ModelQuestion, transcript: string, answersRequired: number): Promise<ModelGrade | null> {
  if (!isModelReady()) return null;
  try {
    return await mod!.modelGrade(question, transcript, answersRequired);
  } catch {
    return null;
  }
}

/** Test helper: forget the loaded model so a test can exercise the fallback. */
export function resetModelForTests() {
  loading = null;
  mod = null;
  state = { status: "idle", loaded: 0, total: 0, fromCache: false };
  for (const fn of listeners) fn(state);
}
