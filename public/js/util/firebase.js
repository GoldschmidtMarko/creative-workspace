// Single shared Firebase initialization for the whole site. Every page/module
// imports app/functions/db/auth from here so the app is initialized exactly once
// and the emulators are connected exactly once.
import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFunctions, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { firebaseConfig } from "./firebaseConfig.js";

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const functions = getFunctions(app);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Point at the local emulators when running on localhost.
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}
