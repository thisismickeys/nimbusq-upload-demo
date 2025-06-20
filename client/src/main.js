// ──────────────────────────────────────────────────────────────
// Nimbus‑Q Front‑End (Enterprise Demo)  ‑ main.js  2025‑06‑20
// ------------------------------------------------------------------
// This file replaces your previous /src/main.js.  Drop it in the same
// folder and reload your dev server – no other build‑steps needed.
// ------------------------------------------------------------------

/*
  New features
  ────────────
  1.  "📎  Copy share link" button that appears after upload.
  2.  "🔮 Ask AI" button—opens a chat page seeded with the video URL.
  3.  Countdown now uses the *exact* expiresAt timestamp returned by
      the backend, so demo & production tiers stay in‑sync.
  4.  Extra error handling & clipboard helpers.
*/

// ─────────── DOM ---------------------------------------------------
const videoUpload     = document.getElementById('videoUpload');
const dropZone        = document.getElementById('dropZone');
const deleteTime      = document.getElementById('deleteTime');
const customDeleteTime= document.getElementById('customDeleteTime');
const uploadBtn       = document.getElementById('uploadBtn');
const progressBar     = document.getElementById('progressBar');
const status          = document.getElementById('status');
const countdown       = document.getElementById('countdown');
const timeLeft        = document.getElementById('timeLeft');
const spinner         = document.getElementById('spinner');
const shareLinkEl     = document.getElementById('shareLink');
const openAiBtn       = document.getElementById('openAiChat');

// ─────────── CONFIG ----------------------------------------------
const API_BASE   = 'https://us-central1-nimbus-q.cloudfunctions.net/nimbusq';
const PUBLIC_URL = 'https://nimbus-q.web.app';   // adjust if bucket path differs

// ─────────── STATE -----------------------------------------------
let uploadResult      = null;
let countdownInterval = null;

// ─────────── INIT -------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  updateStatus('Please select a video file.');
});

function setupEventListeners() {
  videoUpload.addEventListener('change', e => updateFileDisplay(e.target.files[0]));
  uploadBtn   .addEventListener('click', handleUpload);

  // Drag & drop helpers
  ['dragenter','dragover','dragleave','drop'].forEach(evt => {
    dropZone.addEventListener(evt, preventDefaults, false);
    document.body.addEventListener(evt, preventDefaults, false);
  });
  dropZone.addEventListener('dragover',() => highlightDrop(true));
  dropZone.addEventListener('dragleave',() => highlightDrop(false));
  dropZone.addEventListener('drop', handleDrop);

  // Share link copy
  shareLinkEl.addEventListener('click', copyShareLink);
}

function preventDefaults(e){ e.preventDefault(); e.stopPropagation(); }
function highlightDrop(state){
  dropZone.classList.toggle('dragover', state);
}

function handleDrop(e){
  highlightDrop(false);
  const file = e.dataTransfer.files[0];
  if(file && file.type.startsWith('video/')){
    videoUpload.files = e.dataTransfer.files;
    updateFileDisplay(file);
  } else updateStatus('❌ Please drop a video file.', 'error');
}

function updateFileDisplay(file){
  if(file){
    dropZone.classList.add('has-file');
    dropZone.dataset.filename = `${file.name} (${(file.size/1_048_576).toFixed(2)} MB)`;
    updateStatus(`📁 Selected: ${file.name}`,'info');
    uploadBtn.disabled = false;
  } else {
    dropZone.classList.remove('has-file');
    dropZone.removeAttribute('data-filename');
    updateStatus('Please select a video file.');
    uploadBtn.disabled = true;
  }
}

// ─────────── UPLOAD ----------------------------------------------
async function handleUpload(){
  const file = videoUpload.files[0];
  if(!file) return updateStatus('❌ Please choose a file first.','error');
  if(!file.type.startsWith('video/')) return updateStatus('❌ File must be a video.','error');

  const ttl = deleteTime.value || customDeleteTime.value || '2m';
  spinner.style.display = 'block';
  progressBar.style.display = 'block'; progressBar.value = 10;
  uploadBtn.disabled = true;
  updateStatus('⏳ Reading file…','info');

  try{
    const buffer = await file.arrayBuffer();
    progressBar.value = 35;

    updateStatus('⏳ Uploading…','info');
    const res = await fetch(API_BASE, {
      method:'POST',
      headers:{
        'Content-Type':'application/octet-stream',
        'X-File-Name':file.name,
        'X-File-Type':file.type,
        'X-Delete-After':ttl,
        'X-User-Tier':'demo',
        'X-User-ID':'web-demo'
      },
      body:buffer
    });

    progressBar.value = 85;
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    uploadResult = await res.json();
    progressBar.value = 100;
    updateStatus('✅ Upload successful!','success');

    // Build public URL & UI extras
    const url = `${PUBLIC_URL}/${uploadResult.filePath}`;
    showShareLink(url);
    showAiButton(url);

    startExpiryCountdown(uploadResult.expiresAt);
    console.log('[Nimbus‑Q] Upload →', uploadResult);

  }catch(err){
    console.error(err);
    updateStatus(`❌ Upload failed: ${err.message}`,'error');
  }finally{
    spinner.style.display='none';
    uploadBtn.disabled = false;
    setTimeout(()=>progressBar.style.display='none', 800);
  }
}

// ─────────── UI EXTRAS -------------------------------------------
function showShareLink(url){
  shareLinkEl.textContent = '📎 Copy share link';
  shareLinkEl.dataset.url = url;
  shareLinkEl.style.display = 'block';
}

async function copyShareLink(){
  try{
    await navigator.clipboard.writeText(shareLinkEl.dataset.url);
    shareLinkEl.textContent = '✅ Copied!';
    setTimeout(()=>shareLinkEl.textContent='📎 Copy share link', 2000);
  }catch{
    alert('Copy failed – here is the link:\n' + shareLinkEl.dataset.url);
  }
}

function showAiButton(url){
  openAiBtn.style.display = 'inline-block';
  openAiBtn.onclick = () => {
    // Placeholder – swap for your real AI chat route
    const chatUrl = `/ai-chat?video=${encodeURIComponent(url)}`;
    window.open(chatUrl,'_blank');
  };
}

// ─────────── COUNTDOWN -------------------------------------------
function startExpiryCountdown(iso){
  const end   = new Date(iso).getTime();
  const tick  = () => {
    const left = end - Date.now();
    if(left<=0){
      timeLeft.textContent = 'Deleted';
      clearInterval(countdownInterval);
      return;
    }
    const s = Math.floor(left/1000)%60;
    const m = Math.floor(left/60000)%60;
    const h = Math.floor(left/3600000);
    timeLeft.textContent = h?`${h}h ${m}m ${s}s`:m?`${m}m ${s}s`:`${s}s`;
  };
  clearInterval(countdownInterval);
  tick();
  countdownInterval = setInterval(tick,1000);
}

// ─────────── STATUS UX -------------------------------------------
function updateStatus(msg,type='neutral'){
  status.textContent = msg;
  const colors = {neutral:'#333',info:'#4da8ff',success:'#44b044',error:'#e14d4d'};
  status.style.color = colors[type]||colors.neutral;
}

// ─────────── Cosmetic helper for drag‑over state ------------------
const css = document.createElement('style');
css.textContent = `.drop-zone.dragover{background:rgba(77,168,255,.1)!important;border-color:#4da8ff!important;}`;
document.head.appendChild(css);
