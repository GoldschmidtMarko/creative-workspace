// Shared "favorites" (starred tournaments/disciplines/players) store, used by
// player.js, tournament.js and index.js. Favorites live at
// users/{uid}.favorites.<type>.<id> — written via the toggle_favorite
// callable (the app's rule is that all writes to users/{uid} go through the
// backend) and read directly here via onSnapshot, since the existing
// Firestore rules already let a signed-in user read their own users/{uid}
// document.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { doc, onSnapshot } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { functions, db, auth } from "./firebase.js";

const toggleFavoriteFn = httpsCallable(functions, "toggle_favorite", { timeout: 20000 });
const EMPTY = { tournament: {}, discipline: {}, player: {} };

let favorites = EMPTY;
let unsubDoc = null;
const listeners = new Set();

function notify() {
    listeners.forEach((fn) => {
        try { fn(favorites); } catch (e) { console.error(e); }
    });
}

// Subscribe to favorites changes; called immediately with the current value,
// then again whenever it changes. Returns an unsubscribe function.
export function onFavoritesChange(fn) {
    listeners.add(fn);
    fn(favorites);
    return () => listeners.delete(fn);
}

export function isFavorite(type, id) {
    return !!(id && favorites[type] && favorites[type][id]);
}

export function currentFavorites() {
    return favorites;
}

document.addEventListener("authchange", (e) => {
    if (unsubDoc) { unsubDoc(); unsubDoc = null; }
    const user = e.detail && e.detail.user;
    if (!user) { favorites = EMPTY; notify(); return; }
    unsubDoc = onSnapshot(doc(db, "users", user.uid), (snap) => {
        const f = (snap.data() || {}).favorites || {};
        favorites = { tournament: f.tournament || {}, discipline: f.discipline || {}, player: f.player || {} };
        notify();
    }, (err) => console.warn("favorites listener failed:", err?.message || err));
});

// Star/unstar one item. `meta` is small extra display/link data (e.g.
// sp_code+profile_id for a player, tournamentId+event for a discipline) —
// see favorites.py's META_FIELDS for the allow-list of keys actually kept.
// The star button itself is visible to everyone (see .star-btn in main.css)
// — clicking it while signed out prompts the same Google popup the nav
// button uses, then, once signed in, continues on to actually star the
// item, rather than leaving the user to click a second time.
export async function toggleFavorite(type, id, name, meta = {}) {
    if (!id) return false;
    if (!document.documentElement.classList.contains("is-authed")) {
        try {
            await signInWithPopup(auth, new GoogleAuthProvider());
        } catch (err) {
            if (err?.code !== "auth/popup-closed-by-user" && err?.code !== "auth/cancelled-popup-request") {
                console.error("Sign-in failed:", err);
            }
            return false;
        }
    }
    const starred = !isFavorite(type, id);
    // Optimistic local update so the star flips instantly; the onSnapshot
    // listener reconciles with the server's copy moments later regardless.
    const next = { ...favorites, [type]: { ...favorites[type] } };
    if (starred) next[type][id] = { name, ...meta };
    else delete next[type][id];
    favorites = next;
    notify();
    try {
        await toggleFavoriteFn({ type, id, starred, name, meta });
    } catch (err) {
        console.error("toggleFavorite failed:", err);
    }
    return starred;
}

// Mount a self-updating star toggle button into `container`. Re-mounting
// into the same container (e.g. the player page loading a new player) first
// tears down the previous subscription so listeners don't pile up.
export function mountFavoriteStar(container, { type, id, name, meta = {}, label, iconOnly } = {}) {
    if (!container) return;
    if (container._favUnsub) { container._favUnsub(); container._favUnsub = null; }
    if (!type || !id) { container.innerHTML = ""; return; }

    const labelHtml = label ? `<span class="star-btn__label"></span>` : "";
    const cls = iconOnly ? "star-btn star-btn--icon" : "star-btn";
    container.innerHTML = `<button type="button" class="${cls}"><i data-lucide="star"></i>${labelHtml}</button>`;
    const btn = container.querySelector(".star-btn");
    const labelEl = label ? btn.querySelector(".star-btn__label") : null;

    function paint() {
        const on = isFavorite(type, id);
        btn.classList.toggle("is-starred", on);
        btn.setAttribute("aria-pressed", String(on));
        btn.title = on ? "Remove from favorites" : "Add to favorites";
        if (labelEl) labelEl.textContent = on ? (label.on || "Starred") : (label.off || "Star");
    }
    btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(type, id, name, meta);
    });
    container._favUnsub = onFavoritesChange(paint);
    if (window.lucide) lucide.createIcons();
}
