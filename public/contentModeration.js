// contentModeration.js
// A pluggable wrapper around any TF.js–compatible NSFW model.
// Licensees can override the URL by passing their own `modelUrl` into `loadModel()`.

export let model = null;

// By default, load NSFWJS from the CDN.
// If you’d like to self‐host the bundle, replace this with your local path,
// e.g. '/vendor/nsfwjs.min.js'
const DEFAULT_MODEL = 'https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js';

/**
 * Loads the NSFW model bundle.
 * @param {string} [modelUrl] – URL to the NSFWJS bundle (JS file). 
 *                              If omitted, DEFAULT_MODEL is used.
 * @returns {Promise<object>} – The loaded NSFWJS model.
 */
export async function loadModel(modelUrl) {
  const url = modelUrl || DEFAULT_MODEL;
  // Dynamically import the NSFWJS bundle
  const nsfwModule = await import(url);
  // The default export exposes a `.load()` method
  model = await nsfwModule.default.load();
  return model;
}

/**
 * Classifies a single canvas frame.
 * @param {HTMLCanvasElement} canvas – A canvas with the current video frame drawn.
 * @returns {Promise<Array>} – Array of prediction objects.
 */
export function classifyFrame(canvas) {
  if (!model) {
    throw new Error('Model not loaded. Call loadModel() first.');
  }
  return model.classify(canvas);
}
