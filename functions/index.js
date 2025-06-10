// ✅ Imports
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { https } = require("firebase-functions/v2");
const { setGlobalOptions } = require("firebase-functions/v2");
const { scheduler } = require("firebase-functions/v2");
const { Storage } = require("@google-cloud/storage");
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const express = require("express");
const multer = require("multer");
const cors = require("cors");

const tf = require('@tensorflow/tfjs-node');
const nsfw = require('nsfwjs');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const os = require('os');
const path = require('path');
const fs = require('fs');

// point FFmpeg at its binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ✅ DON'T load the NSFW model globally - only load it when needed
// const modelPromise = nsfw.load(); // REMOVED - was causing memory issues

// ✅ Init
admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();
const gcs = new Storage();
setGlobalOptions({ memory: "512MiB", region: "us-central1" });

// ✅ CONFIGURABLE: License buyers can change these values
const CONFIG = {
  // How often the cleanup runs (license buyers can modify)
  CLEANUP_SCHEDULE: "every 2 minutes", // Test frequency - change to "every 24 hours" for production
  
  // Default deletion window if none specified (license buyers can modify)
  DEFAULT_DELETE_AFTER: "24h", // or "1h", "7d", etc.
  
  // Demo mode settings
  DEMO_MODE: false, // set to true for demo mode (skips AI processing)
};

// ✅ Helper: Convert deleteAfter string like "10m", "24h", "3d" → ms
function parseDeleteAfter(input) {
  if (!input) return parseDeleteAfter(CONFIG.DEFAULT_DELETE_AFTER);
  const match = input.match(/^([0-9]+)([mhd])$/);
  if (!match) return parseDeleteAfter(CONFIG.DEFAULT_DELETE_AFTER);
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return parseDeleteAfter(CONFIG.DEFAULT_DELETE_AFTER);
  }
}

// ✅ Express Upload API with Rate Limiting and File Restrictions
const app = express();
app.use(cors({ origin: true }));

// Rate limiting storage (in-memory for demo, use Redis for production)
const rateLimitMap = new Map();
const RATE_LIMIT_REQUESTS = 10; // uploads per hour per IP
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in milliseconds

// Enhanced upload with file restrictions
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 1 // Only allow 1 file per request
  },
  fileFilter: (req, file, cb) => {
    // Only allow video files
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// Rate limiting middleware
const checkRateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  
  // Clean up old entries
  for (let [ip, data] of rateLimitMap.entries()) {
    if (now - data.firstRequest > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(ip);
    }
  }
  
  // Check current IP
  const userData = rateLimitMap.get(clientIP);
  if (!userData) {
    // First request from this IP
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (now - userData.firstRequest > RATE_LIMIT_WINDOW) {
    // Window expired, reset
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (userData.count >= RATE_LIMIT_REQUESTS) {
    // Rate limit exceeded
    return res.status(429).json({
      error: "Rate limit exceeded",
      message: `Maximum ${RATE_LIMIT_REQUESTS} uploads per hour allowed`,
      resetTime: new Date(userData.firstRequest + RATE_LIMIT_WINDOW).toISOString()
    });
  } else {
    // Within limits, increment counter
    userData.count++;
    next();
  }
};

app.post("/upload", checkRateLimit, upload.single("file"), async (req, res) => {
  const file = req.file;
  const deleteAfter = req.body.deleteAfter || "2m";
  const userTier = req.body.userTier || "demo";
  const licenseeId = req.body.licenseeId || "demo";
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

  if (!file) return res.status(400).json({ error: "No file uploaded" });

  // Additional file validation
  if (file.size > 100 * 1024 * 1024) {
    return res.status(400).json({ error: "File too large (max 100MB)" });
  }

  const pathName = `uploads/${Date.now()}_${file.originalname}`;
  const fileUpload = bucket.file(pathName);

  try {
    await fileUpload.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        metadata: { 
          deleteAfter,
          userTier,
          licenseeId,
          uploadIP: clientIP,
          uploadTime: new Date().toISOString(),
          fileSize: file.size.toString()
        },
      },
    });

    return res.status(200).json({
      message: "✅ Upload successful!",
      path: pathName,
      expiresIn: deleteAfter,
      userTier: userTier,
      fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    
    // Handle specific multer errors
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File too large (max 100MB)" });
    } else if (error.message === 'Only video files are allowed') {
      return res.status(400).json({ error: "Only video files are allowed" });
    }
    
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ✅ Deployable API Route
exports.api = https.onRequest({ region: "us-central1" }, app);

// ✅ FIXED: Schedule deletion in Firestore when file is uploaded
exports.scheduleFileDeletion = onObjectFinalized(
  { region: "us-central1", memory: "512MiB" }, // Increased memory
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
    const uploadTime = new Date(event.data.timeCreated).getTime();
    const metadata = event.data.metadata || {};

    // Only process video files
    if (!contentType || !contentType.startsWith("video/")) return;

    // Get deleteAfter from metadata, default to 24h failsafe
    const deleteAfter = metadata.deleteAfter || CONFIG.DEFAULT_DELETE_AFTER;
    const deleteDelayMs = parseDeleteAfter(deleteAfter);
    const expiresAt = uploadTime + deleteDelayMs;

    console.log(`📦 File uploaded: ${filePath}`);
    console.log(`⏱️ Will expire at: ${new Date(expiresAt).toISOString()}`);
    console.log(`🔧 Delete delay: ${deleteDelayMs}ms (${deleteAfter})`);
    console.log(`👤 User: ${metadata.userTier} | Licensee: ${metadata.licenseeId || 'demo'}`);

    // Store in Firestore for cleanup with enhanced metadata
    // Use auto-generated document ID and store filePath as a field
    await db.collection("pending_deletions").add({
      filePath,
      expiresAt,
      confirmedByAI: false,
      uploadTime,
      deleteAfter,
      userTier: metadata.userTier || 'demo',
      licenseeId: metadata.licenseeId || 'demo',
      uploadIP: metadata.uploadIP || 'unknown',
      fileSize: metadata.fileSize || 'unknown',
      contentType
    });

    console.log(`🛡️ Deletion scheduled for ${filePath}`);
  }
);

// ✅ FIXED: Scheduled Cleanup Task (v2)
exports.cleanupExpiredFiles = scheduler.onSchedule({
  schedule: CONFIG.CLEANUP_SCHEDULE,
  region: "us-central1",
  memory: "512MiB" // Increased memory
}, async (event) => {
  const now = Date.now();
  console.log(`🧹 Running cleanup at ${new Date(now).toISOString()}`);

  const snapshot = await db.collection("pending_deletions")
    .where("expiresAt", "<=", now)
    .get();

  console.log(`📋 Found ${snapshot.size} files to potentially delete`);

  const deletions = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    const { filePath } = data;
    
    console.log(`🗑️ Attempting to delete: ${filePath} (expired at ${new Date(data.expiresAt).toISOString()})`);
    
    deletions.push(
      bucket.file(filePath).delete()
        .then(() => {
          console.log(`✅ Successfully deleted expired file: ${filePath}`);
          return doc.ref.delete();
        })
        .then(() => {
          console.log(`✅ Removed tracking record for: ${filePath}`);
        })
        .catch(err => {
          if (err.code === 404) {
            console.log(`⚠️ File already deleted: ${filePath}, removing tracking record`);
            return doc.ref.delete();
          } else {
            console.error(`❌ Error deleting ${filePath}:`, err);
            throw err;
          }
        })
    );
  });

  try {
    await Promise.all(deletions);
    console.log(`🎉 Cleanup completed successfully`);
  } catch (error) {
    console.error(`💥 Cleanup failed:`, error);
    throw error;
  }
});

// ✅ DEMO-AWARE: NSFW Scan on Upload (your original function with demo mode check)
exports.scanNSFWOnUpload = onObjectFinalized(
  { memory: "512MiB", region: "us-central1" },
  async (event) => {
    // Skip AI processing in demo mode
    if (CONFIG.DEMO_MODE) {
      console.log(`🎭 Demo mode: Skipping NSFW scan for ${event.data.name}`);
      return;
    }

    const { name: filePath, bucket: bucketName, contentType } = event.data;
    if (!contentType?.startsWith("video/")) return;

    const bucketRef = gcs.bucket(bucketName);
    const fileRef = bucketRef.file(filePath);
    const tmpLocalPath = path.join(os.tmpdir(), path.basename(filePath));

    // 1) download the video
    await fileRef.download({ destination: tmpLocalPath });

    // 2) extract a 224×224 frame
    const framePath = `${tmpLocalPath}.jpg`;
    await new Promise((res, rej) => {
      ffmpeg(tmpLocalPath)
        .outputOptions(["-vf", "scale=224:224", "-vframes", "1"])
        .output(framePath)
        .on("end", res)
        .on("error", rej)
        .run();
    });

    // 3) classify it - load model only when needed
    const imageBuffer = fs.readFileSync(framePath);
    const imgTensor = tf.node.decodeImage(imageBuffer, 3);
    const model = await nsfw.load(); // Load model only in this function
    const preds = await model.classify(imgTensor);
    imgTensor.dispose();

    // 4) check Porn score > 0.7
    const pornScore = preds.find(p => p.className === "Porn")?.probability || 0;
    const isNSFW = pornScore > 0.7;

    // 5) tag the file with metadata and AI confirmation
    await fileRef.setMetadata({
      metadata: { 
        nsfw: isNSFW.toString(),
        scanResult: isNSFW ? 'rejected' : 'clean',
        aiProcessed: 'true',
        scanTimestamp: new Date().toISOString()
      }
    });

    console.log(`🔍 Scanned ${filePath}: NSFW=${isNSFW} (${isNSFW ? 'REJECTED' : 'CLEAN'})`);

    // 6) Update Firestore to mark AI as confirmed
    try {
      // Find document by filePath field instead of document ID
      const snapshot = await db.collection("pending_deletions")
        .where("filePath", "==", filePath)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        await snapshot.docs[0].ref.update({
          confirmedByAI: true,
          scanResult: isNSFW ? 'rejected' : 'clean'
        });
      } else {
        console.warn(`⚠️ No pending deletion record found for ${filePath}`);
      }
    } catch (err) {
      console.warn(`⚠️ Could not update AI confirmation for ${filePath}: ${err.message}`);
    }

    // 7) cleanup temp files
    try {
      fs.unlinkSync(tmpLocalPath);
      fs.unlinkSync(framePath);
    } catch (err) {
      console.warn(`⚠️ Could not clean up temp files: ${err.message}`);
    }
  }
);