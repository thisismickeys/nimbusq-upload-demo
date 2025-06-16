// ✅ Imports
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { https } = require("firebase-functions/v2");
const { setGlobalOptions } = require("firebase-functions/v2");
const { scheduler } = require("firebase-functions/v2");
const { Storage } = require("@google-cloud/storage");
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

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ✅ Firebase Initialization
admin.initializeApp();
const bucket = admin.storage().bucket('nimbus-q.appspot.com');
const gcs = new Storage();
const db = admin.firestore();

setGlobalOptions({ memory: "512MiB", region: "us-central1" });

// ✅ Config
const CONFIG = {
  CLEANUP_SCHEDULE: "every 24 hours",
  DEFAULT_DELETE_AFTER: "24h",
  DEMO_MODE: true,
};

// ✅ Time Parser
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

// ✅ Express Setup
const app = express();
app.use(cors({ origin: true }));

const rateLimitMap = new Map();
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'), false);
  }
});

const checkRateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  for (let [ip, data] of rateLimitMap.entries()) {
    if (now - data.firstRequest > RATE_LIMIT_WINDOW) rateLimitMap.delete(ip);
  }
  const userData = rateLimitMap.get(clientIP);
  if (!userData) {
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (now - userData.firstRequest > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (userData.count >= RATE_LIMIT_REQUESTS) {
    return res.status(429).json({ error: "Rate limit exceeded" });
  } else {
    userData.count++;
    next();
  }
};

// ✅ Upload Endpoint
app.post("/upload", checkRateLimit, upload.single("file"), async (req, res) => {
  const file = req.file;
  const deleteAfter = req.body.deleteAfter || "2m";
  const userTier = req.body.userTier || "demo";
  const licenseeId = req.body.licenseeId || "demo";
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

  if (!file) return res.status(400).json({ error: "No file uploaded" });

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
      userTier,
      fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    return res.status(500).json({ error: "Upload failed" });
  }
});

exports.api = https.onRequest({ region: "us-central1" }, app);

// ✅ Finalized File Trigger → Schedule Deletion
exports.handleFileFinalize = onObjectFinalized({ region: "us-central1", memory: "512MiB" }, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType;
  const uploadTime = new Date(event.data.timeCreated).getTime();
  const metadata = event.data.metadata || {};
  const bucketName = event.data.bucket;
  const storageBucket = gcs.bucket(bucketName);

  if (!filePath || !contentType?.startsWith("video/")) return;

  const deleteAfter = metadata.deleteAfter || CONFIG.DEFAULT_DELETE_AFTER;
  const deleteDelayMs = parseDeleteAfter(deleteAfter);
  const expiresAt = uploadTime + deleteDelayMs;

  const safeDocId = path.basename(filePath).replace(/[^\w\-\.]/g, '_');

  const maxRetries = 5;
  let fileExists = false;
  for (let i = 0; i < maxRetries; i++) {
    const [exists] = await storageBucket.file(filePath).exists();
    if (exists) {
      fileExists = true;
      break;
    }
    console.log(`⏳ Retry ${i + 1}/${maxRetries}: File not found — waiting...`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (!fileExists) {
    console.warn(`❌ Still couldn't find file in bucket: ${filePath}. Skipping Firestore entry.`);
    return;
  }

  try {
    await db.collection("pending_deletions").doc(safeDocId).set({
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
    }, { merge: true });

    console.log(`🛡️ Deletion scheduled for ${filePath}`);
  } catch (error) {
    console.error(`❌ Firestore write failed for ${filePath}:`, error.message);
  }
});

// ✅ Scheduled Cleanup
exports.cleanupExpiredFiles = scheduler.onSchedule({
  schedule: CONFIG.CLEANUP_SCHEDULE,
  region: "us-central1",
  memory: "512MiB"
}, async () => {
  const now = Date.now();
  console.log(`🧹 Cleanup triggered at ${new Date(now).toISOString()}`);

  try {
    const snapshot = await db.collection("pending_deletions")
      .where("expiresAt", "<=", now)
      .get();

    if (snapshot.empty) {
      console.log("🟡 No expired files found.");
      return;
    }

    const deletions = snapshot.docs.map(doc => (async () => {
      const data = doc.data();
      const fileToDelete = data.originalFilePath || data.filePath;

      if (!fileToDelete) {
        console.warn(`⚠️ Missing filePath in doc ${doc.id}`);
        return;
      }

      try {
        const [exists] = await bucket.file(fileToDelete).exists();
        if (exists) {
          await bucket.file(fileToDelete).delete();
          console.log(`✅ Deleted file: ${fileToDelete}`);
        } else {
          console.log(`⚠️ File already gone: ${fileToDelete}`);
        }
      } catch (err) {
        console.error(`❌ Deletion error for ${fileToDelete}:`, err);
      }

      try {
        await doc.ref.delete();
        console.log(`🧼 Removed tracking doc: ${doc.id}`);
      } catch (err) {
        console.error(`❌ Failed to delete Firestore doc ${doc.id}:`, err);
      }
    })());

    await Promise.all(deletions);
    console.log("🎉 Cleanup finished.");
  } catch (err) {
    console.error("💥 Cleanup function crashed:", err);
  }
});