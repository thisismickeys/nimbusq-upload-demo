// public/firebase.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js";
import {
  getStorage,
  ref,
  uploadBytesResumable
} from "https://www.gstatic.com/firebasejs/9.6.1/firebase-storage.js";

// Your Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyBs0wKx9YJKnoo5578Urop2gXXK5vbA5-Q",
  authDomain: "nimbus-q.firebaseapp.com",
  projectId: "nimbus-q",
  storageBucket: "nimbus-q.firebasestorage.app",
  messagingSenderId: "37946773673",
  appId: "1:37946773673:web:207c75b86716502bb299b8",
  measurementId: "G-2D6K67SZN6"
};

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
