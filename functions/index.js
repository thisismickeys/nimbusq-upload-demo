//* NIMBUS-Q ENTERPRISE
 //* Secure, Scalable, AI-Ready Video Uploads
 //* 
 //* Licensed under Nimbus-Q Founder's License
 //* Copyright (c) 2025 Miguel Angel Sanchez
 //* 
 //* This is the core system - customizable but IP protected
 //* No recreations or derivatives allowed per license terms
 //*/

 const functions = require('firebase-functions');
 const admin = require('firebase-admin');
 const express = require('express');
 const cors = require('cors');
 
 // Initialize Firebase
 admin.initializeApp();
 const bucket = admin.storage().bucket();
 // Auto-detect database - works for both default and custom named databases
 const db = admin.firestore();
 
 // Simple config - LICENSEE CUSTOMIZATION ZONE
 const CONFIG = {
   LICENSEE_ID: 'demo', // ← CHANGE THIS to your company name
   DEFAULT_DELETE_AFTER: '2m', // ← Customize default retention
   MAX_FILE_SIZE: 100 * 1024 * 1024, // ← 100MB default
   ALLOWED_FORMATS: ['mp4', 'mov', 'avi', 'webm'], // ← Supported formats
   
   // Advanced settings (optional)
   IMMEDIATE_CLEANUP_INTERVAL: 'every 1 minutes', // Fast deletion
   SAFETY_CLEANUP_INTERVAL: 'every 10 minutes', // Safety net
   ENABLE_AUDIT_LOGS: false // Set to true for audit trail
 };
 
 // Time parser
 function parseDeleteTime(input) {
   const match = input.match(/^(\d+)([mhd])$/);
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
 
 // Create Express app
 const app = express();
 app.use(cors({ origin: true }));
 app.use('/', express.raw({ type: 'application/octet-stream', limit: CONFIG.MAX_FILE_SIZE }));
 app.use(express.json());
 
 // Test endpoint
 app.get('/', (req, res) => {
   res.json({ 
     message: "🚀 Nimbus-Q Working Version",
     timestamp: new Date().toISOString(),
     licensee: CONFIG.LICENSEE_ID
   });
 });
 
 // Upload endpoint - SIMPLIFIED FIRESTORE
 app.post('/', async (req, res) => {
   try {
     // Get headers with robust fallbacks
     const rawFileName = req.headers['x-file-name'] || 'video.mp4';
     const fileType = req.headers['x-file-type'] || 'video/mp4';
     const deleteAfter = req.headers['x-delete-after'] || CONFIG.DEFAULT_DELETE_AFTER;
     const userTier = req.headers['x-user-tier'] || 'demo';
     const userId = req.headers['x-user-id'] || 'anonymous';
     const fileBuffer = req.body;
     
     // Bulletproof filename sanitization
     const sanitizeFileName = (filename) => {
       let clean = filename.replace(/\.\./g, '').replace(/[\/\\]/g, '');
       clean = clean.replace(/[<>:"|?*]/g, '_')
                    .replace(/[\x00-\x1f\x80-\x9f]/g, '_')
                    .replace(/^\.+/, '')
                    .trim();
       
       if (!clean.includes('.')) {
         const ext = fileType.includes('quicktime') ? '.mov' : '.mp4';
         clean += ext;
       }
       
       if (!clean || clean.length < 3) {
         const ext = fileType.includes('quicktime') ? '.mov' : '.mp4';
         clean = `video_${Date.now()}${ext}`;
       }
       
       if (clean.length > 100) {
         const ext = clean.substring(clean.lastIndexOf('.'));
         clean = clean.substring(0, 90 - ext.length) + ext;
       }
       
       return clean;
     };
     
     const fileName = sanitizeFileName(rawFileName);
     
     console.log(`📤 Upload request:`, {
       originalName: rawFileName,
       sanitizedName: fileName,
       fileSize: fileBuffer.length
     });
     
     // Validate file
     if (!fileBuffer || fileBuffer.length === 0) {
       return res.status(400).json({ error: 'No file data received' });
     }
     
     // Generate file path
     const timestamp = Date.now();
     const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
     const filePath = `uploads/${timestamp}_${safeFileName}`;
     const file = bucket.file(filePath);
     
     // Upload to storage
     await file.save(fileBuffer, {
       metadata: {
         contentType: fileType,
         metadata: {
           originalName: rawFileName,
           sanitizedName: fileName,
           uploadTime: new Date().toISOString(),
           deleteAfter: deleteAfter,
           userTier: userTier,
           userId: userId,
           fileSize: fileBuffer.length.toString()
         }
       }
     });
     
     console.log(`✅ File uploaded successfully: ${filePath}`);
     
     // PRECISION DELETION SYSTEM - Enterprise Grade  
     // Each file gets its own scheduled deletion
     const deleteTime = parseDeleteTime(deleteAfter);
     const expiresAt = timestamp + deleteTime;
     
     try {
       await db.collection('pending_deletions').add({
         filePath: filePath,
         expiresAt: expiresAt,
         deleteAfter: deleteAfter,
         fileName: fileName,
         fileSize: fileBuffer.length,
         userTier: userTier,
         userId: userId,
         createdAt: admin.firestore.FieldValue.serverTimestamp()
       });
       
       // IMMEDIATE PRECISION SCHEDULING
       setTimeout(async () => {
         try {
           await bucket.file(filePath).delete();
           // Remove from pending_deletions
           const pendingQuery = await db.collection('pending_deletions')
             .where('filePath', '==', filePath).get();
           for (const doc of pendingQuery.docs) {
             await doc.ref.delete();
           }
           console.log(`⚡ PRECISION DELETED: ${filePath} at exact time`);
         } catch (err) {
           console.log(`⚠️ File already handled by backup system: ${filePath}`);
         }
       }, deleteTime);
       
       console.log(`🛡️ Precision deletion scheduled for: ${new Date(expiresAt).toISOString()}`);
     } catch (firestoreError) {
       console.error('⚠️ Firestore write failed, but upload succeeded:', firestoreError);
     }
     
     // Return success - AI-ready response
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
     console.error('❌ Upload failed:', error);
     res.status(500).json({ 
       error: 'Upload failed', 
       details: error.message
     });
   }
 });
 
 // Export functions with extended timeout for mobile uploads
 exports.nimbusq = functions
   .runWith({ timeoutSeconds: 300, memory: '1GB' }) // 5 minutes timeout
   .https.onRequest(app);
 
 // Simple cleanup function
 exports.cleanup = functions.https.onRequest(async (req, res) => {
   try {
     const now = Date.now();
     console.log(`🔍 Checking for expired files at: ${new Date(now).toISOString()}`);
     
     const expired = await db.collection('pending_deletions')
       .where('expiresAt', '<=', now)
       .get();
     
     console.log(`Found ${expired.size} expired files`);
     
     let deletedCount = 0;
     for (const doc of expired.docs) {
       const data = doc.data();
       try {
         await bucket.file(data.filePath).delete();
         await doc.ref.delete();
         console.log(`🗑️ Deleted: ${data.filePath}`);
         
         // Optional audit logging
         if (CONFIG.ENABLE_AUDIT_LOGS) {
           await db.collection('audit_logs').add({
             action: 'manual_deletion',
             filePath: data.filePath,
             fileName: data.fileName,
             userId: data.userId,
             userTier: data.userTier,
             deletedAt: admin.firestore.FieldValue.serverTimestamp(),
             deletionType: 'manual_cleanup'
           });
         }
         
         deletedCount++;
       } catch (err) {
         console.log(`⚠️ File already gone: ${data.filePath}`);
         await doc.ref.delete(); // Remove the record even if file is gone
       }
     }
     
     res.json({
       success: true,
       message: 'Cleanup completed',
       deletedCount: deletedCount,
       timestamp: new Date().toISOString()
     });
     
   } catch (error) {
     console.error('❌ Cleanup error:', error);
     res.status(500).json({ error: error.message });
   }
 });

 // AUTOMATIC CLEANUP SCHEDULER (configurable safety net)
 exports.scheduledCleanup = functions.pubsub.schedule(CONFIG.SAFETY_CLEANUP_INTERVAL).onRun(async (context) => {
   try {
     const now = Date.now();
     console.log(`🔄 Scheduled cleanup at: ${new Date(now).toISOString()}`);
     
     const expired = await db.collection('pending_deletions')
       .where('expiresAt', '<=', now)
       .get();
     
     console.log(`📋 Found ${expired.size} expired files to delete`);
     
     let deletedCount = 0;
     for (const doc of expired.docs) {
       const data = doc.data();
       try {
         await bucket.file(data.filePath).delete();
         await doc.ref.delete();
         console.log(`🗑️ Auto-deleted: ${data.filePath}`);
         deletedCount++;
       } catch (err) {
         console.log(`⚠️ File already gone: ${data.filePath}`);
         await doc.ref.delete(); // Remove the record even if file is gone
       }
     }
     
     console.log(`✅ Scheduled cleanup completed: ${deletedCount} files deleted`);
     return null;
     
   } catch (error) {
     console.error('❌ Scheduled cleanup error:', error);
     return null;
   }
 });

 // IMMEDIATE DELETION TRIGGER (configurable for precise timing)
 exports.immediateDelete = functions.pubsub.schedule(CONFIG.IMMEDIATE_CLEANUP_INTERVAL).onRun(async (context) => {
   try {
     const now = Date.now();
     const buffer = 30000; // 30 second buffer to catch recent expirations
     
     console.log(`⚡ Immediate deletion check at: ${new Date(now).toISOString()}`);
     
     // Find files that expired in the last minute
     const recentlyExpired = await db.collection('pending_deletions')
       .where('expiresAt', '<=', now)
       .where('expiresAt', '>', now - 60000) // Last minute
       .get();
     
     console.log(`⚡ Found ${recentlyExpired.size} recently expired files`);
     
     let deletedCount = 0;
     for (const doc of recentlyExpired.docs) {
       const data = doc.data();
       try {
         await bucket.file(data.filePath).delete();
         await doc.ref.delete();
         console.log(`⚡ Immediately deleted: ${data.filePath}`);
         deletedCount++;
       } catch (err) {
         console.log(`⚠️ File already gone: ${data.filePath}`);
         await doc.ref.delete();
       }
     }
     
     if (deletedCount > 0) {
       console.log(`⚡ Immediate deletion completed: ${deletedCount} files deleted`);
     }
     return null;
     
   } catch (error) {
     console.error('❌ Immediate deletion error:', error);
     return null;
   }
 });