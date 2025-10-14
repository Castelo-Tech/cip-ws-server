// Simple, idempotent Firebase Admin bootstrap using ADC (GOOGLE_APPLICATION_CREDENTIALS)
// or the environment your VM already has.
import admin from 'firebase-admin';

let initialized = false;

export function initFirebaseAdmin() {
  if (initialized) return admin;
  try {
    admin.initializeApp({
      // Will use Application Default Credentials by default.
      // If you prefer explicit service account:
      // credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
      credential: admin.credential.applicationDefault(),
    });
    initialized = true;
  } catch (e) {
    // In case of hot-reload or multiple imports where app is already initialized
    if (!/already exists/i.test(String(e?.message || ''))) throw e;
    initialized = true;
  }
  return admin;
}

export { admin };
