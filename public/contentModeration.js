// contentModeration.js
// A pluggable wrapper around any TF.js-compatible NSFW model.
// Licensees can override window.NQ_CONFIG.modelUrl before this script runs.

export let model = null;

// Default to nsfwjs if no custom URL provided
const DEFAULT_MODEL = 'https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js';

export async function loadModel(modelUrl) {
  const url = modelUrl || DEFAULT_MODEL;
  // dynamic import of the chosen bundle
  const module = await import(url);
  // nsfwjs exposes .default.load()
  model = await module.default.load();
  return model;
}

// Takes a canvas element (with a video frame drawn) and returns the predictions
export function classifyFrame(canvas) {
  if (!model) throw new Error('Model not loaded');
  return model.classify(canvas);
}
