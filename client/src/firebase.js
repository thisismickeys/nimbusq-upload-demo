// Only keep this if you still use Firebase elsewhere (like auth or Firestore)
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";

// Your Firebase config from .env
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID
};

console.log("FIREBASE CONFIG:", firebaseConfig);

// Initialize Firebase (still needed if other parts of app use it)
const app = initializeApp(firebaseConfig);

/**
 * Uploads file via the backend API so it triggers all the scheduled deletion + Firestore logic.
 * Calls onProgress (fake progress since API doesn’t stream), onSuccess(result), onError(error)
 */
export async function uploadViaAPI(file, deleteAfter = "2m", onProgress, onSuccess, onError) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("deleteAfter", deleteAfter);
  formData.append("userTier", "demo");
  formData.append("licenseeId", "demo");

  try {
    // Optional: simulate basic progress since fetch doesn't track it natively
    if (onProgress) {
      onProgress(5);
      setTimeout(() => onProgress(30), 200);
      setTimeout(() => onProgress(75), 400);
      setTimeout(() => onProgress(100), 700);
    }

    const response = await fetch("https://us-central1-nimbus-q.cloudfunctions.net/api/upload", {
      method: "POST",
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || "Upload failed");
    }

    const result = await response.json();
    console.log("✅ Upload via API result:", result);
    if (onSuccess) onSuccess(result);
  } catch (err) {
    console.error("❌ Upload via API failed:", err);
    if (onError) onError(err);
  }
}