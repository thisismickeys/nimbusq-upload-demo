// ✅ Imports
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { https } = require("firebase-functions/v2");
const { setGlobalOptions } = require("firebase-functions/v2");
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

// load the NSFW model once, from our local folder
const modelPromise = nsfw.load();
// ✅ Init
admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();
const gcs = new Storage();
setGlobalOptions({ memory: "512MiB", region: "us-central1" });

// ✅ Helper: Convert deleteAfter string like "10m", "24h", "3d" → ms
function parseDeleteAfter(input) {
  if (!input) return 24 * 60 * 60 * 1000; // default failsafe: 24h
  const match = input.match(/^([0-9]+)([mhd])$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

// ✅ On Upload: Schedule auto-deletion
exports.scheduleFileDeletion = onObjectFinalized(
  { region: "us-central1", memory: "256MiB" },
  async (event) => {
    const filePath = event.data.name;
    const bucketName = event.data.bucket;
    const metadata = event.data.metadata || {};
    const deleteCode = metadata.deleteAfter;
    const delay = parseDeleteAfter(deleteCode);

    console.log(`📦 File uploaded: ${filePath}`);
    console.log(`⏱️ Scheduling deletion in ${delay / 1000}s`);

    setTimeout(async () => {
      try {
        const fileRef = gcs.bucket(bucketName).file(filePath);
        const [exists] = await fileRef.exists();
        if (exists) {
          await fileRef.delete();
          console.log(`🧹 File deleted: ${filePath}`);
        } else {
          console.log(`⚠️ Already deleted or missing: ${filePath}`);
        }
      } catch (err) {
        console.error(`❌ Error deleting file ${filePath}:`, err);
      }
    }, delay);
  }
);

// ✅ Express Upload API
const app = express();
app.use(cors({ origin: true }));
const upload = multer({ storage: multer.memoryStorage() });

app.post("/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  const deleteAfter = req.body.deleteAfter || "2m";

  if (!file) return res.status(400).send("❌ No file uploaded.");

  const pathName = `uploads/${Date.now()}_${file.originalname}`;
  const fileUpload = bucket.file(pathName);

  try {
    await fileUpload.save(file.buffer, {
      metadata: {
        contentType: file.mimetype,
        metadata: { deleteAfter },
      },
    });

    return res.status(200).send({
      message: "✅ Uploaded!",
      path: pathName,
    });
  } catch (error) {
    console.error("❌ Upload failed:", error);
    return res.status(500).send("Upload failed.");
  }
});

// ✅ Deployable API Route
exports.api = https.onRequest({ region: "us-central1" }, app);

// ✅ Failsafe Deletion Tracker (Firestore)
exports.scheduleFailsafeDeletion = functions.storage.object().onFinalize(async (object) => {
  const filePath = object.name;
  const contentType = object.contentType;
  const uploadTime = new Date(object.timeCreated).getTime();

  if (!contentType || !contentType.startsWith("video/")) return;

  const DEFAULT_EXPIRATION_MS = 24 * 60 * 60 * 1000;
  const expiresAt = uploadTime + DEFAULT_EXPIRATION_MS;

  await db.collection("pending_deletions").doc(filePath).set({
    filePath,
    expiresAt,
    confirmedByAI: false
  });

  console.log(`🛡️ Failsafe scheduled for ${filePath} at ${new Date(expiresAt).toISOString()}`);
});

// ✅ Scheduled Cleanup Task (runs hourly)
exports.cleanupExpiredFiles = functions.pubsub.schedule("every 60 minutes").onRun(async () => {
  const now = Date.now();
  const snapshot = await db.collection("pending_deletions")
    .where("expiresAt", "<=", now)
    .where("confirmedByAI", "==", false)
    .get();

  const deletions = [];

  snapshot.forEach(doc => {
    const { filePath } = doc.data();
    deletions.push(
      bucket.file(filePath).delete().then(() => {
        console.log(`🧹 Deleted expired file: ${filePath}`);
        return doc.ref.delete();
      }).catch(err => console.error(`❌ Error deleting ${filePath}:`, err))
    );
  });

  await Promise.all(deletions);
});

// ✅ NSFW Scan on Upload
exports.scanNSFWOnUpload = onObjectFinalized(
  { memory: "512MiB", region: "us-central1" },
  async (event) => {
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

    // 3) classify it
    const imageBuffer = fs.readFileSync(framePath);
    const imgTensor = tf.node.decodeImage(imageBuffer, 3);
    const model = await modelPromise;
    const preds = await model.classify(imgTensor);
    imgTensor.dispose();

    // 4) check Porn score > 0.7
    const pornScore = preds.find(p => p.className === "Porn")?.probability || 0;
    const isNSFW = pornScore > 0.7;

    // 5) tag the file with metadata
    await fileRef.setMetadata({
      metadata: { nsfw: isNSFW.toString() }
    });

    console.log(`🔍 Scanned ${filePath}: NSFW=${isNSFW}`);
  }
);
