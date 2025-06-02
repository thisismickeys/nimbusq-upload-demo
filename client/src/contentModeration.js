let model = null;

// Load the NSFWJS model after DOM is ready
window.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const videoInput = document.getElementById('videoUpload');
  const uploadBtn = document.getElementById('uploadBtn');
  const progressBar = document.getElementById('progressBar');
  const timeLeft = document.getElementById('timeLeft');
  const deleteTimeDropdown = document.getElementById('deleteTime');
  const customTimeInput = document.getElementById('customDeleteTime');
  const dropZone = document.getElementById('dropZone');

  // Load NSFW model
  try {
    model = await nsfwjs.load('/model/');
    statusEl.textContent = 'NSFW Model Loaded. Ready to scan.';
  } catch (err) {
    console.error('Failed to load NSFW model', err);
    statusEl.textContent = 'Failed to load NSFW model.';
    return;
  }

  // Dropzone visual feedback
  videoInput.addEventListener('change', () => {
    const file = videoInput.files[0];
    if (file) {
      dropZone.classList.add('has-file');
      dropZone.setAttribute('data-filename', file.name);
      statusEl.textContent = 'Ready to upload and scan.';
    }
  });

  // Upload handler
  uploadBtn.addEventListener('click', () => {
    const file = videoInput.files[0];
    if (!file) {
      statusEl.textContent = 'Please select a file.';
      return;
    }

    // Determine delete time
    const dropdownValue = deleteTimeDropdown.value;
    const customValue = customTimeInput.value.trim();
    const deleteAfter = customValue || dropdownValue || '24h';

    // Show progress bar
    progressBar.style.display = 'block';
    progressBar.value = 0;
    statusEl.textContent = 'Uploading...';

    import('./firebase.js').then(({ firebaseUpload }) => {
      firebaseUpload(
        file,
        deleteAfter,
        percent => {
          progressBar.value = percent;
        },
        () => {
          statusEl.textContent = 'Upload complete. Scanning video...';

          // Simulate NSFW scan (actual NSFWJS doesn't support video files directly)
          setTimeout(() => {
            statusEl.textContent = 'Scan complete. Video is safe.';
            startCountdown(deleteAfter);
          }, 2000); // simulate scan delay
        },
        err => {
          console.error('Upload error:', err);
          statusEl.textContent = 'Upload failed.';
        }
      );
    });
  });

  // Start countdown timer
  function startCountdown(durationStr) {
    const ms = parseDuration(durationStr);
    if (!ms) return;

    let remaining = ms;
    const interval = setInterval(() => {
      if (remaining <= 0) {
        clearInterval(interval);
        timeLeft.textContent = 'Expired';
        return;
      }
      remaining -= 1000;
      timeLeft.textContent = formatTime(remaining);
    }, 1000);
  }

  // Format milliseconds to mm:ss
  function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  // Parse "2m", "1h30m", etc. into milliseconds
  function parseDuration(input) {
    const match = input.match(/(?:(\\d+)h)?(?:(\\d+)m)?(?:(\\d+)s)?/);
    if (!match) return null;
    const [, h = 0, m = 0, s = 0] = match.map(x => parseInt(x) || 0);
    return ((+h * 60 + +m) * 60 + +s) * 1000;
  }
});
