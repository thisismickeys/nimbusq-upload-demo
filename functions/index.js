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

// ✅ CONSISTENT BUCKET CONFIGURATION
const BUCKET_NAME = 'nimbus-q-clean';
const bucket = admin.storage().bucket(BUCKET_NAME);
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

// Enhanced CORS configuration
app.use(cors({
  origin: [
    'https://nimbus-q.web.app',
    'https://nimbus-q.firebaseapp.com',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

// Add preflight handler
app.options('*', cors());

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

// ✅ Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: "Nimbus-Q API is running!", 
    timestamp: new Date().toISOString(),
    cors: "enabled"
  });
});

// ✅ Upload Endpoint
app.post("/upload", checkRateLimit, upload.single("file"), async (req, res) => {
  // Add CORS headers manually as backup
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  const file = req.file;
  const deleteAfter = req.body.deleteAfter || "2m";
  const userTier = req.body.userTier || "demo";
  const licenseeId = req.body.licenseeId || "demo";
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';

  console.log(`📤 Upload attempt - File: ${file?.originalname}, Size: ${file?.size}, DeleteAfter: ${deleteAfter}`);

  if (!file) {
    console.error("❌ No file in request");
    return res.status(400).json({ error: "No file uploaded" });
  }

  // ✅ RESTORED TIMESTAMP TO PREVENT OVERWRITES
  const pathName = `uploads/${Date.now()}_${file.originalname}`;
  const fileUpload = bucket.file(pathName);

  try {
    console.log(`⬆️ Saving to bucket: ${BUCKET_NAME}/${pathName}`);
    
    await fileUpload.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        metadata: {
          deleteAfter,
          userTier,
          licenseeId,
          uploadIP: clientIP,
          uploadTime: new Date().toISOString(),
          fileSize: file.size.toString(),
          bucketName: BUCKET_NAME
        },
      },
    });

    console.log(`✅ Upload successful: ${pathName}`);

    return res.status(200).json({
      message: "✅ Upload successful!",
      path: pathName,
      expiresIn: deleteAfter,
      userTier,
      fileSize: `${(file.size / 1024 / 1024).toFixed(2)} MB`
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    return res.status(500).json({ 
      error: "Upload failed",
      details: error.message 
    });
  }
});

// ✅ API Export with PUBLIC ACCESS
exports.api = https.onRequest({ 
  region: "us-central1",
  cors: true,
  invoker: "public" // ✅ THIS ALLOWS PUBLIC ACCESS
}, app);

// ✅ Finalized File Trigger → Schedule Deletion
exports.handleFileFinalize = onObjectFinalized({
  region: "us-central1",
  memory: "512MiB",
  bucket: BUCKET_NAME
}, async (event) => {
  const filePath = event.data.name;
  const contentType = event.data.contentType;
  const uploadTime = new Date(event.data.timeCreated).getTime();
  const metadata = event.data.metadata || {};
  const bucketName = event.data.bucket || BUCKET_NAME;

  console.log(`🔔 File finalized: ${filePath} in bucket: ${bucketName}`);

  if (!filePath || !contentType?.startsWith("video/")) {
    console.log(`⏭️ Skipping non-video file: ${filePath}`);
    return;
  }

  const deleteAfter = metadata.deleteAfter || CONFIG.DEFAULT_DELETE_AFTER;
  const deleteDelayMs = parseDeleteAfter(deleteAfter);
  const expiresAt = uploadTime + deleteDelayMs;

  const safeDocId = path.basename(filePath).replace(/[^\w\-\.]/g, '_');
  const targetBucket = gcs.bucket(BUCKET_NAME);

  // ✅ Retry logic to wait for file
  const maxRetries = 5;
  let fileExists = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const [exists] = await targetBucket.file(filePath).exists();
      if (exists) {
        fileExists = true;
        console.log(`✅ File confirmed in bucket after ${i + 1} attempts: ${filePath}`);
        break;
      }
    } catch (error) {
      console.error(`❌ Error checking file existence (attempt ${i + 1}):`, error);
    }
    
    console.log(`⏳ Retry ${i + 1}/${maxRetries}: File not found in ${BUCKET_NAME} — waiting...`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  if (!fileExists) {
    console.warn(`❌ File not found after ${maxRetries} retries: ${BUCKET_NAME}/${filePath}`);
    return;
  }

  try {
    await db.collection("pending_deletions").doc(safeDocId).set({
      filePath,
      bucketName: BUCKET_NAME,
      expiresAt,
      confirmedByAI: false,
      uploadTime,
      deleteAfter,
      userTier: metadata.userTier || 'demo',
      licenseeId: metadata.licenseeId || 'demo',
      uploadIP: metadata.uploadIP || 'unknown',
      fileSize: metadata.fileSize || 'unknown',
      contentType,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log(`🛡️ Deletion scheduled for ${filePath} (expires at: ${new Date(expiresAt).toISOString()})`);
  } catch (error) {
    console.error(`❌ Firestore write failed for ${filePath}:`, error);
  }
});

// ✅ Scheduled Cleanup with Enhanced Debugging
exports.cleanupExpiredFiles = scheduler.onSchedule({
  schedule: CONFIG.CLEANUP_SCHEDULE,
  region: "us-central1",
  memory: "512MiB"
}, async () => {
  const now = Date.now();
  console.log(`🧹 Cleanup triggered at ${new Date(now).toISOString()}`);

  try {
    console.log('📊 Checking Firestore connection...');
    
    // Check total documents first
    const totalSnapshot = await db.collection("pending_deletions").limit(5).get();
    console.log(`📋 Total documents in pending_deletions: ${totalSnapshot.size}`);
    
    if (!totalSnapshot.empty) {
      console.log('📄 Sample documents:');
      totalSnapshot.docs.forEach(doc => {
        const data = doc.data();
        console.log(`  - ${doc.id}: expires ${new Date(data.expiresAt).toISOString()} (${data.expiresAt <= now ? 'EXPIRED' : 'ACTIVE'})`);
      });
    }

    // Get expired files
    const snapshot = await db.collection("pending_deletions")
      .where("expiresAt", "<=", now)
      .get();

    console.log(`🔍 Found ${snapshot.size} expired documents`);

    if (snapshot.empty) {
      console.log("🟡 No expired files found.");
      return;
    }

    const deletions = snapshot.docs.map(doc => (async () => {
      const data = doc.data();
      const fileToDelete = data.filePath;
      const bucketToUse = data.bucketName || BUCKET_NAME;

      console.log(`🗂️ Processing doc ${doc.id}: ${fileToDelete} in bucket ${bucketToUse}`);

      if (!fileToDelete) {
        console.warn(`⚠️ Missing filePath in doc ${doc.id}`);
        return;
      }

      try {
        const targetBucket = gcs.bucket(bucketToUse);
        const [exists] = await targetBucket.file(fileToDelete).exists();
        
        if (exists) {
          await targetBucket.file(fileToDelete).delete();
          console.log(`✅ Deleted file: ${fileToDelete} from bucket: ${bucketToUse}`);
        } else {
          console.log(`⚠️ File already gone: ${fileToDelete} in bucket: ${bucketToUse}`);
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
    console.log("🎉 Cleanup finished successfully.");
  } catch (err) {
    console.error("💥 Cleanup function crashed:", err);
    console.error('Error details:', {
      code: err.code,
      message: err.message,
      stack: err.stack
    });
  }
});

// ✅ Manual cleanup trigger with PUBLIC ACCESS
exports.manualCleanup = https.onRequest({ 
  region: "us-central1",
  invoker: "public" // ✅ THIS ALLOWS PUBLIC ACCESS
}, async (req, res) => {
  try {
    console.log("🔧 Manual cleanup triggered");
    
    const now = Date.now();
    const snapshot = await db.collection("pending_deletions").get();
    
    console.log(`📊 Total documents: ${snapshot.size}`);
    
    const expired = snapshot.docs.filter(doc => doc.data().expiresAt <= now);
    console.log(`⏰ Expired documents: ${expired.length}`);
    
    res.json({
      message: "Manual cleanup check completed",
      totalDocuments: snapshot.size,
      expiredDocuments: expired.length,
      details: expired.map(doc => ({
        id: doc.id,
        filePath: doc.data().filePath,
        expiresAt: new Date(doc.data().expiresAt).toISOString(),
        bucketName: doc.data().bucketName
      }))
    });
  } catch (error) {
    console.error("Manual cleanup failed:", error);
    res.status(500).json({ error: error.message });
  }
});