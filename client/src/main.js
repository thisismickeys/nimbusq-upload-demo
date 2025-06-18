const videoUpload = document.getElementById('videoUpload');
const dropZone = document.getElementById('dropZone');
const deleteTime = document.getElementById('deleteTime');
const customDeleteTime = document.getElementById('customDeleteTime');
const uploadBtn = document.getElementById('uploadBtn');
const progressBar = document.getElementById('progressBar');
const status = document.getElementById('status');
const countdown = document.getElementById('countdown');
const timeLeft = document.getElementById('timeLeft');
const spinner = document.getElementById('spinner');

// API Configuration
const API_BASE = 'https://us-central1-nimbus-q.cloudfunctions.net/upload';

// Global variables
let uploadResult = null;
let countdownInterval = null;

// Initialize when DOM loads
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    updateStatus('Please select a video file.', 'neutral');
});

function setupEventListeners() {
    // File input change
    videoUpload.addEventListener('change', handleFileSelect);
    
    // Upload button
    uploadBtn.addEventListener('click', handleUpload);
    
    // Drag and drop
    dropZone.addEventListener('dragover', handleDragOver);
    dropZone.addEventListener('dragleave', handleDragLeave);
    dropZone.addEventListener('drop', handleDrop);
    
    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleFileSelect(event) {
    const file = event.target.files[0];
    updateFileDisplay(file);
}

function handleDragOver(event) {
    event.preventDefault();
    dropZone.style.backgroundColor = 'rgba(255,255,255,0.8)';
    dropZone.style.borderColor = '#4da8ff';
}

function handleDragLeave(event) {
    event.preventDefault();
    dropZone.style.backgroundColor = '';
    dropZone.style.borderColor = '#ddd';
}

function handleDrop(event) {
    event.preventDefault();
    dropZone.style.backgroundColor = '';
    dropZone.style.borderColor = '#ddd';
    
    const files = event.dataTransfer.files;
    if (files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('video/')) {
            videoUpload.files = files;
            updateFileDisplay(file);
        } else {
            updateStatus('❌ Please select a video file.', 'error');
        }
    }
}

function updateFileDisplay(file) {
    if (file) {
        dropZone.classList.add('has-file');
        dropZone.setAttribute('data-filename', `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
        updateStatus(`📁 Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, 'success');
        uploadBtn.disabled = false;
    } else {
        dropZone.classList.remove('has-file');
        dropZone.removeAttribute('data-filename');
        updateStatus('Please select a video file.', 'neutral');
        uploadBtn.disabled = true;
    }
}

async function handleUpload() {
    const file = videoUpload.files[0];
    
    if (!file) {
        updateStatus('❌ Please select a file first.', 'error');
        return;
    }
    
    // Validate file type
    if (!file.type.startsWith('video/')) {
        updateStatus('❌ Please select a video file.', 'error');
        return;
    }
    
    // Get delete time
    const selectedTime = deleteTime.value || customDeleteTime.value || '2m';
    
    // Show loading state
    uploadBtn.disabled = true;
    spinner.style.display = 'block';
    progressBar.style.display = 'block';
    progressBar.value = 10;
    updateStatus('⏳ Preparing upload...', 'info');
    
    try {
        console.log('📤 Starting upload:', {
            name: file.name,
            size: file.size,
            type: file.type,
            deleteAfter: selectedTime
        });
        
        // Convert file to ArrayBuffer - NO FormData!
        updateStatus('⏳ Reading file...', 'info');
        progressBar.value = 30;
        
        const arrayBuffer = await file.arrayBuffer();
        console.log('📦 File converted to ArrayBuffer:', arrayBuffer.byteLength, 'bytes');
        
        // Upload using raw binary data
        updateStatus('⏳ Uploading...', 'info');
        progressBar.value = 50;
        
        const response = await fetch(API_BASE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/octet-stream',
                'X-File-Name': file.name,
                'X-File-Type': file.type,
                'X-Delete-After': selectedTime,
                'X-File-Size': file.size.toString()
            },
            body: arrayBuffer
        });
        
        progressBar.value = 90;
        
        console.log('📡 Upload response:', {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries())
        });
        
        if (response.ok) {
            const result = await response.json();
            uploadResult = result;
            
            progressBar.value = 100;
            updateStatus('✅ Upload successful!', 'success');
            
            // Start countdown
            startCountdown(selectedTime);
            
            console.log('✅ Upload successful:', result);
            
        } else {
            const errorText = await response.text();
            console.error('❌ Upload failed:', {
                status: response.status,
                statusText: response.statusText,
                body: errorText
            });
            updateStatus(`❌ Upload failed: ${response.status} ${response.statusText}`, 'error');
            progressBar.style.display = 'none';
        }
        
    } catch (error) {
        console.error('❌ Upload error:', error);
        updateStatus(`❌ Upload error: ${error.message}`, 'error');
        progressBar.style.display = 'none';
    } finally {
        // Reset UI
        uploadBtn.disabled = false;
        spinner.style.display = 'none';
    }
}

function updateStatus(message, type = 'neutral') {
    status.textContent = message;
    status.className = `status ${type}`;
    
    // Add some CSS classes for styling
    if (type === 'error') {
        status.style.color = '#ff4444';
    } else if (type === 'success') {
        status.style.color = '#44ff44';
    } else if (type === 'info') {
        status.style.color = '#4da8ff';
    } else {
        status.style.color = '#333';
    }
}

function startCountdown(deleteAfter) {
    // Parse delete time to milliseconds
    const match = deleteAfter.match(/^(\d+)([mhd])$/);
    if (!match) return;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    let totalMs;
    switch (unit) {
        case 'm': totalMs = value * 60 * 1000; break;
        case 'h': totalMs = value * 60 * 60 * 1000; break;
        case 'd': totalMs = value * 24 * 60 * 60 * 1000; break;
        default: return;
    }
    
    const endTime = Date.now() + totalMs;
    
    // Clear any existing countdown
    if (countdownInterval) {
        clearInterval(countdownInterval);
    }
    
    countdownInterval = setInterval(() => {
        const remaining = endTime - Date.now();
        
        if (remaining <= 0) {
            timeLeft.textContent = 'File deleted';
            clearInterval(countdownInterval);
            return;
        }
        
        const hours = Math.floor(remaining / (60 * 60 * 1000));
        const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
        const seconds = Math.floor((remaining % (60 * 1000)) / 1000);
        
        if (hours > 0) {
            timeLeft.textContent = `${hours}h ${minutes}m ${seconds}s`;
        } else if (minutes > 0) {
            timeLeft.textContent = `${minutes}m ${seconds}s`;
        } else {
            timeLeft.textContent = `${seconds}s`;
        }
    }, 1000);
}

// Add some CSS for better status display
const style = document.createElement('style');
style.textContent = `
    .status {
        transition: color 0.3s ease;
        font-weight: 600;
    }
    
    .drop-zone.dragover {
        background-color: rgba(77, 168, 255, 0.1) !important;
        border-color: #4da8ff !important;
        transform: scale(1.02);
        transition: all 0.2s ease;
    }
`;
document.head.appendChild(style);