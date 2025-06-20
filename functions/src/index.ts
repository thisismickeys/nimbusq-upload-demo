import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Initialize Firebase Admin
admin.initializeApp();

// Simple video upload function
export const uploadVideo = functions.https.onRequest(async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.status(405).send('Method Not Allowed');
      return;
    }

    const { fileName, fileSize, userTier } = req.body;
    
    if (!fileName || !fileSize || !userTier) {
      res.status(400).send('Missing required fields');
      return;
    }

    const uploadId = 'nvid_' + Math.random().toString(36).substr(2, 9);
    const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000)); // 24 hours

    const result = {
      uploadId,
      fileName,
      fileSize: parseInt(fileSize),
      userTier,
      expiresAt,
      status: 'uploaded'
    };

    console.log('📤 Video uploaded:', result);

    res.json({
      success: true,
      data: result
    });

  } catch (error: any) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check function
export const healthCheck = functions.https.onRequest(async (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Demo function
export const demo = functions.https.onRequest(async (req, res) => {
  res.json({
    message: 'Nimbus-Q Firebase Functions Demo! 🚀',
    endpoints: [
      'POST /uploadVideo',
      'GET /healthCheck', 
      'GET /demo'
    ]
  });
});