"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.demo = exports.healthCheck = exports.uploadVideo = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
admin.initializeApp();
exports.uploadVideo = functions.https.onRequest(async (req, res) => {
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
        const expiresAt = new Date(Date.now() + (24 * 60 * 60 * 1000));
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
    }
    catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});
exports.healthCheck = functions.https.onRequest(async (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});
exports.demo = functions.https.onRequest(async (req, res) => {
    res.json({
        message: 'Nimbus-Q Firebase Functions Demo! 🚀',
        endpoints: [
            'POST /uploadVideo',
            'GET /healthCheck',
            'GET /demo'
        ]
    });
});
