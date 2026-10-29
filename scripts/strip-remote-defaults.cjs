/**
 * Turbopack (webpack-style) loader for @huggingface/transformers' browser build.
 *
 * The site never contacts a third party: lib/model-runtime.ts sets
 * allowRemoteModels=false and points onnxruntime-web at /ort/ before anything is
 * loaded. This loader removes the unused remote defaults from the bundle as well,
 * so the shipped JavaScript contains no Hugging Face Hub or jsDelivr address at
 * all and a misconfiguration cannot silently fall back to them:
 *
 *   - the jsDelivr wasm prefix (`wasmPaths` default)  -> ""
 *   - `remoteHost: 'https://huggingface.co/'` and documentation links in error
 *     messages                                        -> ""
 *   - the hub host names used to attach HF_TOKEN       -> "hub.invalid"
 *
 * Wired in next.config.mjs (turbopack.rules). Fails the build if the patterns it
 * expects are gone, so a Transformers.js upgrade cannot quietly reintroduce them.
 */
module.exports = function stripRemoteDefaults(source) {
  const cdn = /`https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@\$\{[^}`]*\}\/dist\/`/g;
  if (!cdn.test(source)) {
    throw new Error("strip-remote-defaults: jsDelivr wasmPaths default not found; re-check after upgrading @huggingface/transformers");
  }
  return source
    .replace(cdn, '""')
    .replace(/https?:\/\/(?:[a-z0-9-]+\.)*(?:huggingface\.co|hf\.co)\/?[^\s'"`)]*/gi, "")
    .replace(/https?:\/\/(?:cdn\.)?jsdelivr\.net[^\s'"`)]*/gi, "")
    .replace(/(['"])(?:huggingface\.co|hf\.co)\1/g, '"hub.invalid"');
};
