/**
 * Fully static export: `npm run build` writes a self-contained site to out/.
 *
 * Set NEXT_PUBLIC_BASE_PATH to serve from a sub-path, e.g. a GitHub Pages
 * project site at https://<user>.github.io/civics-trainer:
 *
 *   NEXT_PUBLIC_BASE_PATH=/civics-trainer npm run build
 *
 * The same variable is inlined into the client bundle, where lib/use-speech.ts
 * uses it to build audio URLs and lib/model-runtime.ts to find the grading model
 * (public/models/) and the onnxruntime-web wasm (public/ort/).
 */
import { fileURLToPath } from "node:url";

const raw = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").trim().replace(/\/+$/, "");
const basePath = raw && !raw.startsWith("/") ? `/${raw}` : raw;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  turbopack: {
    // Transformers.js imports "onnxruntime-web", whose default build is the JSEP
    // (WebGPU-capable) one with a 21.6 MB wasm. The grader only uses the CPU
    // WebAssembly backend, so the browser bundle uses the wasm-only build instead
    // (same CPU kernels, 11 MB wasm). Node (vitest, eval) uses onnxruntime-node.
    resolveAlias: {
      "onnxruntime-web": { browser: "onnxruntime-web/wasm" },
    },
    rules: {
      // Strip Transformers.js' unused Hugging Face Hub / jsDelivr defaults from the bundle.
      "*.js": {
        condition: { path: /@huggingface\/transformers\/dist\/transformers\.web(\.min)?\.js$/ },
        loaders: [fileURLToPath(new URL("./scripts/strip-remote-defaults.cjs", import.meta.url))],
        as: "*.js",
      },
    },
  },
};

export default nextConfig;
