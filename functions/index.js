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

// ✅ Initialize Firebase Admin
admin.initializeApp();
const bucket = admin.storage().bucket('nimbus-q.firebasestorage.app');
const gcs = new Storage();
const db = admin.firestore(); // ✅ Firestore via Admin SDK

setGlobalOptions({ memory: "512MiB", region: "us-central1" });

// ✅ Configuration
const CONFIG = {
  CLEANUP_SCHEDULE: "every 24 hours", // Change to "every 2 minutes" if needed
  DEFAULT_DELETE_AFTER: "24h",
  DEMO_MODE: true,
};

// ✅ Helper: Parse deletion time
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
  limits: { fileSize: 100 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

const checkRateLimit = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
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

// ✅ Auto-Schedule Deletion
exports.scheduleFileDeletion = onObjectFinalized(
  { region: "us-central1", memory: "512MiB" },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType;
    const uploadTime = new Date(event.data.timeCreated).getTime();
    const metadata = event.data.metadata || {};

    if (!filePath || !contentType || !contentType.startsWith("video/")) {
      console.warn("🟡 Skipping non-video file or missing data");
      return;
    }

    const deleteAfter = metadata.deleteAfter || CONFIG.DEFAULT_DELETE_AFTER;
    const userTier = metadata.userTier || "demo";
    const licenseeId = metadata.licenseeId || "demo";
    const uploadIP = metadata.uploadIP || "unknown";
    const fileSize = metadata.fileSize || "unknown";
    const deleteDelayMs = parseDeleteAfter(deleteAfter);
    const expiresAt = uploadTime + deleteDelayMs;

    const safeDocId = path.basename(filePath).replace(/[^\w\-\.]/g, '_'); // ✅ FINAL FIX HERE

    console.log(`📦 File uploaded: ${filePath}`);
    console.log(`⏱️ Will expire at: ${new Date(expiresAt).toISOString()}`);
    console.log(`👤 User: ${userTier} | Licensee: ${licenseeId}`);

    try {
      await db.collection("pending_deletions").doc(safeDocId).set({
        filePath,
        expiresAt,
        confirmedByAI: false,
        uploadTime,
        deleteAfter,
        userTier,
        licenseeId,
        uploadIP,
        fileSize,
        contentType
      }, { merge: true });

      console.log(`🛡️ Deletion scheduled for ${filePath}`);
    } catch (error) {
      console.error(`❌ Failed to schedule deletion for ${filePath}:`, error.message || error);
    }
  }
);

// ✅ Cleanup Expired Files
exports.cleanupExpiredFiles = scheduler.onSchedule({
  schedule: CONFIG.CLEANUP_SCHEDULE,
  region: "us-central1",
  memory: "512MiB"
}, async () => {
  const now = Date.now();
  console.log(`🧹 Running cleanup at ${new Date(now).toISOString()}`);

  try {
    const snapshot = await db.collection("pending_deletions")
      .where("expiresAt", "<=", now)
      .get();

    if (snapshot.empty) {
      console.log(`🟡 No expired files found.`);
      return;
    }

    const deletions = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      const { originalFilePath, filePath } = data;
      const fileToDelete = originalFilePath || filePath;

      if (!fileToDelete) {
        console.warn(`⚠️ Document ${doc.id} missing filePath, skipping`);
        return;
      }

      deletions.push(
        bucket.file(fileToDelete).delete()
          .then(() => {
            console.log(`✅ Deleted expired file: ${fileToDelete}`);
            return doc.ref.delete();
          })
          .catch(err => {
            if (err.code === 404) {
              console.log(`⚠️ File not found: ${fileToDelete}, deleting record`);
              return doc.ref.delete();
            } else {
              console.error(`❌ Error deleting ${fileToDelete}:`, err);
            }
          })
      );
    });

    await Promise.all(deletions);
    console.log(`🎉 Cleanup completed`);
  } catch (error) {
    console.error(`💥 Cleanup failed:`, error.message || error);
  }
});

// ✅ Optional NSFW Scanning
exports.scanNSFWOnUpload = onObjectFinalized(
  { memory: "512MiB", region: "us-central1" },
  async (event) => {
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
      await fileRef.download({ destination: tmpLocalPath });
      const framePath = `${tmpLocalPath}.jpg`;
      await new Promise((resolve, reject) => {
        ffmpeg(tmpLocalPath)
          .outputOptions(["-vf", "scale=224:224", "-vframes", "1"])
          .output(framePath)
          .on("end", resolve)
          .on("error", reject)
          .run();
      });

      const imageBuffer = fs.readFileSync(framePath);
      const imgTensor = tf.node.decodeImage(imageBuffer, 3);
      const model = await nsfw.load();
      const preds = await model.classify(imgTensor);
      imgTensor.dispose();

      const pornScore = preds.find(p => p.className === "Porn")?.probability || 0;
      const isNSFW = pornScore > 0.7;

      await fileRef.setMetadata({
        metadata: {
          nsfw: isNSFW.toString(),
          scanResult: isNSFW ? 'rejected' : 'clean',
          aiProcessed: 'true',
          scanTimestamp: new Date().toISOString()
        }
      });

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

      fs.unlinkSync(tmpLocalPath);
      fs.unlinkSync(framePath);
    } catch (error) {
      console.error(`❌ NSFW scan failed for ${filePath}:`, error);
    }
  }
);