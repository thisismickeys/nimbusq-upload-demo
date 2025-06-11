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

// Configure FFmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ✅ Initialize Firebase Admin (simplified)
admin.initializeApp();
const bucket = admin.storage().bucket('nimbus-q.firebasestorage.app');
const gcs = new Storage();

// Use native Firestore admin SDK
const db = admin.firestore(); // Use Admin SDK's built-in credentials

setGlobalOptions({ memory: "512MiB", region: "us-central1" });

// ✅ Configuration (License buyers can customize these)
const CONFIG = {
  CLEANUP_SCHEDULE: "every 24 hours", // Disabled for now - change back to "every 2 minutes" once working
  DEFAULT_DELETE_AFTER: "24h",
  DEMO_MODE: true, // Enable demo mode to skip heavy AI processing
};

// ✅ Helper: Parse deletion time strings
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

// ✅ Express Upload API with Enterprise Features
const app = express();
app.use(cors({ origin: true }));

// Rate limiting (in-memory for demo, use Redis for production)
const rateLimitMap = new Map();
const RATE_LIMIT_REQUESTS = 10; // uploads per hour per IP
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour

// File upload configuration
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { 
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 1
  },
  fileFilter: (req, file, cb) => {
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
  
  const userData = rateLimitMap.get(clientIP);
  if (!userData) {
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (now - userData.firstRequest > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(clientIP, { firstRequest: now, count: 1 });
    next();
  } else if (userData.count >= RATE_LIMIT_REQUESTS) {
    return res.status(429).json({
      error: "Rate limit exceeded",
      message: `Maximum ${RATE_LIMIT_REQUESTS} uploads per hour allowed`
    });
  } else {
    userData.count++;
    next();
  }
};

// Upload endpoint
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
      userTier: userTier,
      fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: "File too large (max 100MB)" });
    } else if (error.message === 'Only video files are allowed') {
      return res.status(400).json({ error: "Only video files are allowed" });
    }
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ✅ API Export
exports.api = https.onRequest({ region: "us-central1" }, app);

// ✅ Schedule File Deletion
exports.scheduleFileDeletion = onObjectFinalized(
  { region: "us-central1", memory: "512MiB" },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
    const uploadTime = new Date(event.data.timeCreated).getTime();
    const metadata = event.data.metadata || {};

    // Only process video files
    if (!contentType || !contentType.startsWith("video/")) return;

    const deleteAfter = metadata.deleteAfter || CONFIG.DEFAULT_DELETE_AFTER;
    const deleteDelayMs = parseDeleteAfter(deleteAfter);
    const expiresAt = uploadTime + deleteDelayMs;

    console.log(`📦 File uploaded: ${filePath}`);
    console.log(`⏱️ Will expire at: ${new Date(expiresAt).toISOString()}`);
    console.log(`👤 User: ${metadata.userTier} | Licensee: ${metadata.licenseeId || 'demo'}`);

    try {
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
    } catch (error) {
      console.error(`❌ Failed to schedule deletion for ${filePath}:`, error);
    }
  }
);

// ✅ Scheduled Cleanup Task
exports.cleanupExpiredFiles = scheduler.onSchedule({
  schedule: CONFIG.CLEANUP_SCHEDULE,
  region: "us-central1",
  memory: "512MiB"
}, async (event) => {
  const now = Date.now();
  console.log(`🧹 Running cleanup at ${new Date(now).toISOString()}`);

  try {
    // Check if collection exists first
    console.log(`🔍 Checking for expired files in pending_deletions collection...`);
    
    const snapshot = await db.collection("pending_deletions")
      .where("expiresAt", "<=", now)
      .get();

    if (snapshot.empty) {
      console.log(`🟡 No expired files found.`);
      return;
    }

    console.log(`📋 Found ${snapshot.size} files to potentially delete`);

    const deletions = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const { filePath } = data;
      
      if (!filePath) {
        console.warn(`⚠️ Document ${doc.id} missing filePath, skipping`);
        return;
      }
      
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

    await Promise.all(deletions);
    console.log(`🎉 Cleanup completed successfully`);
  } catch (error) {
    console.error(`💥 Cleanup failed:`, error.message || error);
    
    // More specific error handling
    if (error.code === 5) {
      console.error(`🔍 NOT_FOUND error - check if pending_deletions collection exists and has proper permissions`);
    }
    
    // Don't throw - let the function complete gracefully
  }
});

// ✅ NSFW Scanning (Optional - disable in demo mode)
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

    try {
      // Download video
      await fileRef.download({ destination: tmpLocalPath });

      // Extract frame for analysis
      const framePath = `${tmpLocalPath}.jpg`;
      await new Promise((resolve, reject) => {
        ffmpeg(tmpLocalPath)
          .outputOptions(["-vf", "scale=224:224", "-vframes", "1"])
          .output(framePath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      // Classify with NSFW model
      const imageBuffer = fs.readFileSync(framePath);
      const imgTensor = tf.node.decodeImage(imageBuffer, 3);
      const model = await nsfw.load();
      const preds = await model.classify(imgTensor);
      imgTensor.dispose();

      const pornScore = preds.find(p => p.className === "Porn")?.probability || 0;
      const isNSFW = pornScore > 0.7;

      // Update file metadata
      await fileRef.setMetadata({
        metadata: { 
          nsfw: isNSFW.toString(),
          scanResult: isNSFW ? 'rejected' : 'clean',
          aiProcessed: 'true',
          scanTimestamp: new Date().toISOString()
        }
      });

      console.log(`🔍 Scanned ${filePath}: NSFW=${isNSFW} (${isNSFW ? 'REJECTED' : 'CLEAN'})`);

      // Update Firestore tracking
      const snapshot = await db.collection("pending_deletions")
        .where("filePath", "==", filePath)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        await snapshot.docs[0].ref.update({
          confirmedByAI: true,
          scanResult: isNSFW ? 'rejected' : 'clean'
        });
      }

      // Cleanup temp files
      fs.unlinkSync(tmpLocalPath);
      fs.unlinkSync(framePath);
    } catch (error) {
      console.error(`❌ NSFW scan failed for ${filePath}:`, error);
    }
  }
);