import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import {
  getStorage,
  ref,
  uploadBytesResumable
} from "https://www.gstatic.com/firebasejs/9.6.1/firebase-storage.js";

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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const storage = getStorage(app);

/**
 * Uploads `file` to Storage under "uploads/…".  
 * Calls onProgress(percent), onSuccess(), onError(err).
 */
export function firebaseUpload(file, deleteAfter, onProgress, onSuccess, onError) {
  const path = `uploads/${Date.now()}_${file.name}`;
  const metadata = {
    contentType: file.type,
    customMetadata: { deleteAfter }
  };
  const uploadTask = uploadBytesResumable(ref(storage, path), file, metadata);

  uploadTask.on(
    "state_changed",
    snapshot => {
      const pct = Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100);
      onProgress(pct);
    },
    error => onError(error),
    () => onSuccess()
  );
}
