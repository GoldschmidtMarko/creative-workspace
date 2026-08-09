// Google sign-in + activity tracking, shared across pages. Adds a sign-in/out
// button behavior to the topbar #auth-btn and records a login on sign-in.
import {
    GoogleAuthProvider,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { auth, functions } from "./firebase.js";

const saveUserActivity = httpsCallable(functions, "save_user_activity", { timeout: 30000 });
const authBtn = document.getElementById("auth-btn");

// Expose the current user for other modules that gate on auth.
window.currentUser = null;

function render(user) {
    if (!authBtn) return;
    if (user) {
        const first = user.displayName ? user.displayName.split(" ")[0] : "Account";
        authBtn.textContent = first;
        authBtn.title = `Sign out${user.email ? " (" + user.email + ")" : ""}`;
        authBtn.dataset.state = "in";
    } else {
        authBtn.textContent = "Sign in";
        authBtn.title = "Sign in with Google";
        authBtn.dataset.state = "out";
    }
}

onAuthStateChanged(auth, (user) => {
    window.currentUser = user || null;
    render(user);
    // Toggle a root class so auth-gated UI can show/hide via CSS.
    document.documentElement.classList.toggle("is-authed", !!user);
    // Let page code react to auth changes.
    document.dispatchEvent(new CustomEvent("authchange", { detail: { user: user || null } }));

    if (user) {
        saveUserActivity().catch((e) => console.warn("Activity save failed:", e?.message || e));
    }
});

if (authBtn) {
    authBtn.addEventListener("click", async () => {
        try {
            if (authBtn.dataset.state === "in") {
                await signOut(auth);
            } else {
                await signInWithPopup(auth, new GoogleAuthProvider());
            }
        } catch (e) {
            if (e?.code !== "auth/popup-closed-by-user" && e?.code !== "auth/cancelled-popup-request") {
                console.error("Auth error:", e);
            }
        }
    });
}
