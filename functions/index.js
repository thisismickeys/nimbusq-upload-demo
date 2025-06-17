const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

// Initialize Firebase
admin.initializeApp();
const bucket = admin.storage().bucket();
const db = admin.firestore();

// Create Express app
const app = express();

// Enable CORS for all routes
app.use(cors({ origin: true }));

// Middleware to parse raw body for file uploads
app.use('/upload', express.raw({ 
  type: 'application/octet-stream',
  limit: '100mb' 
}));

app.use(express.json());

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: "🚀 Nimbus-Q Upload Service - WORKING!",
    timestamp: new Date().toISOString(),
    version: "v2.0-bulletproof"
  });
});

// Upload endpoint - NO MULTER!
app.post('/upload', async (req, res) => {
  try {
    console.log('📤 Upload request received');
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Body type:', typeof req.body);
    console.log('Body length:', req.body ? req.body.length : 'undefined');

    // Get file data from request body
    const fileBuffer = req.body;
    
    if (!fileBuffer || fileBuffer.length === 0) {
      console.error('❌ No file data received');
      return res.status(400).json({ 
        error: 'No file data received',
        debug: {
          bodyType: typeof req.body,
          bodyLength: req.body ? req.body.length : 'undefined',
          headers: req.headers
        }
      });
    }

    // Get metadata from headers
    const fileName = req.headers['x-file-name'] || `video_${Date.now()}.mp4`;
    const fileType = req.headers['x-file-type'] || 'video/mp4';
    const deleteAfter = req.headers['x-delete-after'] || '2m';
    
    console.log(`📁 Processing file: ${fileName}, size: ${fileBuffer.length}, type: ${fileType}`);

    // Generate unique file path
    const filePath = `uploads/${Date.now()}_${fileName}`;
    const file = bucket.file(filePath);

    // Upload to Firebase Storage
    await file.save(fileBuffer, {
      metadata: {
        contentType: fileType,
        metadata: {
          originalName: fileName,
          uploadTime: new Date().toISOString(),
          deleteAfter: deleteAfter,
          userTier: 'demo',
          licenseeId: 'demo'
        }
      }
    });

    console.log(`✅ File uploaded successfully: ${filePath}`);

    // Schedule deletion
    const deleteTime = parseDeleteTime(deleteAfter);
    const expiresAt = Date.now() + deleteTime;
    
    await db.collection('pending_deletions').add({
      filePath: filePath,
      expiresAt: expiresAt,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      deleteAfter: deleteAfter,
      fileName: fileName,
      fileSize: fileBuffer.length
    });

    console.log(`🗓️ Deletion scheduled for: ${new Date(expiresAt).toISOString()}`);

    // Return success response
    res.json({
      success: true,
      message: "✅ Upload successful!",
      fileName: fileName,
      filePath: filePath,
      fileSize: `${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`,
      expiresIn: deleteAfter,
      expiresAt: new Date(expiresAt).toISOString()
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ 
      error: 'Upload failed', 
      details: error.message,
      stack: error.stack 
    });
  }
});

// Helper function to parse delete time
function parseDeleteTime(deleteAfter) {
  const match = deleteAfter.match(/^(\d+)([mhd])$/);
  if (!match) return 2 * 60 * 1000; // Default 2 minutes
  
  const value = parseInt(match[1]);
  const unit = match[2];
  
  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 2 * 60 * 1000;
  }
}

// Cleanup function
app.post('/cleanup', async (req, res) => {
  try {
    console.log('🧹 Manual cleanup triggered');
    const now = Date.now();
    
    const expired = await db.collection('pending_deletions')
      .where('expiresAt', '<=', now)
      .get();
    
    console.log(`Found ${expired.size} expired files`);
    
    const deletions = expired.docs.map(async (doc) => {
      const data = doc.data();
      try {
        await bucket.file(data.filePath).delete();
        await doc.ref.delete();
        console.log(`🗑️ Deleted: ${data.filePath}`);
      } catch (err) {
        console.log(`⚠️ File already gone: ${data.filePath}`);
        await doc.ref.delete(); // Remove the record anyway
      }
    });
    
    await Promise.all(deletions);
    
    res.json({
      message: 'Cleanup completed',
      deletedCount: expired.size
    });
    
  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export the function
exports.upload = functions.https.onRequest(app);

// Scheduled cleanup
exports.scheduledCleanup = functions.pubsub
  .schedule('every 1 hours')
  .onRun(async (context) => {
    console.log('🕐 Scheduled cleanup running...');
    
    const now = Date.now();
    const expired = await db.collection('pending_deletions')
      .where('expiresAt', '<=', now)
      .get();
    
    console.log(`Found ${expired.size} expired files to delete`);
    
    const deletions = expired.docs.map(async (doc) => {
      const data = doc.data();
      try {
        await bucket.file(data.filePath).delete();
        await doc.ref.delete();
        console.log(`🗑️ Deleted: ${data.filePath}`);
      } catch (err) {
        console.log(`⚠️ File already gone: ${data.filePath}`);
        await doc.ref.delete();
      }
    });
    
    await Promise.all(deletions);
    console.log('✅ Scheduled cleanup completed');
  });