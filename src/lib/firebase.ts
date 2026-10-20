import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, GoogleAuthProvider, type Auth } from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, connectStorageEmulator, type FirebaseStorage } from 'firebase/storage';
import { getFunctions, connectFunctionsEmulator, type Functions } from 'firebase/functions';

export const ALLOWED_DOMAIN = process.env.NEXT_PUBLIC_ALLOWED_DOMAIN || 'kku.ac.th';

const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || 'fake-api-key-for-local-emulator',
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'borrowoas.firebaseapp.com',
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || 'borrowoas',
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || 'borrowoas.firebasestorage.app',
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '1032738070863',
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || '1:1032738070863:web:7f55c50b467c67eda0253a',
};

interface FB {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  storage: FirebaseStorage;
}

let cache: FB | null = null;

/**
 * Lazily initialise Firebase (browser only).
 * เพิ่ม experimentalAutoDetectLongPolling เพื่อป้องกันเน็ตเวิร์ก/ไฟร์วอลล์บล็อก WebSocket
 */
export function fb(): FB {
  if (cache) return cache;
  const app = getApps()[0] ?? initializeApp(config);
  const auth = getAuth(app);

  let db: Firestore;
  try {
    db = initializeFirestore(app, {
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    db = getFirestore(app);
  }

  const storage = getStorage(app);

  if (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }

  cache = { app, auth, db, storage };
  return cache;
}

export function googleProvider() {
  const p = new GoogleAuthProvider();
  // hd = hint ให้ Google แสดงเฉพาะบัญชีโดเมนมหาวิทยาลัย (ยังต้องตรวจซ้ำฝั่งระบบ)
  p.setCustomParameters({ hd: ALLOWED_DOMAIN, prompt: 'select_account' });
  return p;
}

export function getFbFunctions(): Functions {
  const { app } = fb();
  const fn = getFunctions(app, 'asia-southeast1');
  if (process.env.NEXT_PUBLIC_USE_EMULATOR === 'true') {
    try {
      connectFunctionsEmulator(fn, '127.0.0.1', 5001);
    } catch {}
  }
  return fn;
}
