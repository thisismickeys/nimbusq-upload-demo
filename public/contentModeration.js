// public/contentModeration.js

export let model = null;

/**
 * Loads the NSFWJS model from your own /model/ folder.
 * Make sure public/model/ contains model.json, weights_manifest.json, and all .bin shards.
 */
export async function loadModel() {
  if (!window.nsfwjs) {
    throw new Error(
      'NSFWJS global not found; please include `<script src="https://cdn.jsdelivr.net/npm/nsfwjs@2.4.0/dist/nsfwjs.min.js"></script>` in your index.html'
    );
  }

  // Local directory (with trailing slash)
  const MODEL_URL = '/model/';

  // NSFWJS will do MODEL_URL + 'model.json' + shard files
  model = await window.nsfwjs.load(MODEL_URL);
  return model;
}

/**
 * Takes a <canvas> and returns the NSFW predictions.
 */
export function classifyFrame(canvas) {
  if (!model) {
    throw new Error('Model not loaded – call loadModel() first.');
  }
  return model.classify(canvas);
}

import { firebaseUpload } from './firebase.js';

const fileInput  = document.getElementById('videoUpload');
const dropZone   = document.getElementById('dropZone');
const uploadBtn  = document.getElementById('uploadBtn');
const progressEl = document.getElementById('progressBar');
const statusTxt  = document.getElementById('status');
const deleteSel  = document.getElementById('deleteTime');
const customIn   = document.getElementById('customDeleteTime');
const timeLeftEl = document.getElementById('timeLeft');

let modelPromise;

// 1) Show filename in the drop zone
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) {
    const name = fileInput.files[0].name;
    dropZone.classList.add('has-file');
    dropZone.setAttribute('data-filename', name);
    statusTxt.textContent = `Selected: ${name}`;
  } else {
    dropZone.classList.remove('has-file');
    dropZone.removeAttribute('data-filename');
    statusTxt.textContent = 'Please select a video file.';
  }
});

// 2) Pre-load the NSFW model
(async () => {
  statusTxt.textContent = 'Loading NSFW model…';
  try {
    modelPromise = loadModel();
    await modelPromise;
    statusTxt.textContent = 'NSFW model ready.';
  } catch (e) {
    console.error('NSFW load failed', e);
    statusTxt.textContent = 'Failed to load NSFW model.';
  }
})();

// 3) Scan → then upload
uploadBtn.addEventListener('click', async () => {
  if (!fileInput.files.length) {
    statusTxt.textContent = 'No file selected!';
    return;
  }
  const file = fileInput.files[0];
  statusTxt.textContent = 'Scanning for NSFW…';

  let preds;
  try {
    // grab a frame around 1s in
    const vid = document.createElement('video');
    vid.src = URL.createObjectURL(file);
    await new Promise(res => (vid.onloadeddata = res));
    vid.currentTime = Math.min(1, vid.duration / 2);
    await new Promise(res => (vid.onseeked = res));

    // draw to canvas
    const canvas = document.createElement('canvas');
    canvas.width = vid.videoWidth;
    canvas.height = vid.videoHeight;
    canvas.getContext('2d').drawImage(vid, 0, 0);

    await modelPromise;
    preds = await classifyFrame(canvas);
    console.log('NSFW preds:', preds);
  } catch (err) {
    console.error(err);
    statusTxt.textContent = 'Error scanning content.';
    return;
  }

  // compute NSFW score
  const score = preds
    .filter(p => ['Porn','Hentai','Sexy'].includes(p.className))
    .reduce((sum, p) => sum + p.probability, 0);

  const code = customIn.value || deleteSel.value || '2m';

  const doUpload = () => {
    statusTxt.textContent = 'Uploading…';
    progressEl.style.display = 'block';
    firebaseUpload(
      file,
      code,
      pct => (progressEl.value = pct),
      () => window.dispatchEvent(
        new CustomEvent('uploadComplete', { detail:{ deleteAfter: code } })
      ),
      err => {
        console.error(err);
        statusTxt.textContent = 'Upload failed.';
      }
    );
  };

  if (score > 0.7) {
    statusTxt.textContent = '⚠️ NSFW detected.';
    if (confirm('Content may be inappropriate. Proceed?')) doUpload();
    else statusTxt.textContent = 'Upload cancelled.';
  } else {
    statusTxt.textContent = 'Content is clean. Uploading…';
    doUpload();
  }
});

// 4) Show deletion countdown
let countdownInterval;
window.addEventListener('uploadComplete', e => {
  clearInterval(countdownInterval);
  const amt = parseInt(e.detail.deleteAfter, 10);
  const unit = e.detail.deleteAfter.slice(-1);
  let ms = unit === 'h'
    ? amt * 3600000
    : unit === 'd'
    ? amt * 86400000
    : amt * 60000;
  const end = Date.now() + ms;

  countdownInterval = setInterval(() => {
    const diff = end - Date.now();
    if (diff <= 0) {
      clearInterval(countdownInterval);
      statusTxt.textContent = 'File deleted.';
      timeLeftEl.textContent = '00:00';
      return;
    }
    const m = String(Math.floor(diff / 60000)).padStart(2,'0');
    const s = String(Math.floor((diff % 60000) / 1000)).padStart(2,'0');
    timeLeftEl.textContent = `${m}:${s}`;
  }, 1000);
});
