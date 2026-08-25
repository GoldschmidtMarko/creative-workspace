// Site-wide feedback widget: a bottom-left row of floating buttons (About /
// why-is-this-slow / feedback), loaded on every page. Self-contained — reads
// no page-specific state, so it's the same include everywhere.
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js";
import { functions } from "./firebase.js";

const submitFeedback = httpsCallable(functions, "submit_feedback", { timeout: 30000 });

function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
}

/* ---------------- generic popup shell -------------------------------- */
function openPopup(bodyHtml, { title, wide = false } = {}) {
    const overlay = document.createElement("div");
    overlay.className = "fb-overlay";
    overlay.innerHTML = `
        <div class="fb-popup" style="${wide ? "max-width:520px" : ""}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || "")}">
            <div class="fb-popup__head">
                <div class="fb-popup__title">${escapeHtml(title || "")}</div>
                <button type="button" class="fb-popup__close" aria-label="Close">
                    <i data-lucide="x" style="width:16px;height:16px;"></i>
                </button>
            </div>
            <div class="fb-popup__body">${bodyHtml}</div>
        </div>`;
    document.body.appendChild(overlay);
    if (window.lucide) lucide.createIcons();

    const close = () => {
        overlay.classList.remove("is-open");
        setTimeout(() => overlay.remove(), 200);
        document.removeEventListener("keydown", onKey);
    };
    const onKey = (e) => { if (e.key === "Escape") close(); };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    overlay.querySelector(".fb-popup__close").addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => overlay.classList.add("is-open"));

    return { overlay, close };
}

/* ---------------- About popup ------------------------------------------ */
function showAboutPopup() {
    openPopup(`
        <p>BAX Checker pulls together a badminton player's rating history from
        <strong>badminton-bax.de</strong> and their tournaments, leagues, titles
        and win/loss record from <strong>dbv.turnier.de</strong> — so you don't
        have to hop between both sites to see the full picture.</p>
        <p>It's a one-person hobby project, not an official DBV or
        badminton-bax.de tool.</p>
        <p>Questions, problems, or ideas? Reach out at
        <a href="mailto:baxcheck@gmail.com">baxcheck@gmail.com</a>.</p>
    `, { title: "About BAX Checker" });
}

/* ---------------- "why is this slow" popup ------------------------------ */
function showSlowPopup() {
    openPopup(`
        <p>BAX Checker runs on a free hosting tier, which is what allows it to
        remain freely available to everyone. The trade-off is that the server
        goes to sleep after a period of inactivity, so the first request that
        comes in afterward needs a few seconds to spin it back up.</p>
        <p>Once it's active, every subsequent request is handled quickly.
        Thank you for your patience during that initial moment.</p>
    `, { title: "Why is this slow sometimes?" });
}

/* ---------------- feedback popup ---------------------------------------- */
const FEEDBACK_CATEGORIES = [
    { value: "bug", label: "Bug" },
    { value: "feature", label: "Feature request" },
    { value: "data", label: "Wrong or missing data" },
    { value: "other", label: "Other" },
];

function showFeedbackPopup() {
    const { overlay, close } = openPopup(`
        <p style="text-align:center;margin-bottom:1rem;">Found a bug, want a feature, or spotted bad data? Let me know.</p>
        <select class="field fb-select" id="fb-category">
            ${FEEDBACK_CATEGORIES.map((c) => `<option value="${c.value}">${escapeHtml(c.label)}</option>`).join("")}
        </select>
        <textarea class="field" id="fb-message" rows="5" maxlength="2000" placeholder="What's going on..." style="resize:vertical;"></textarea>
        <p class="fb-status" id="fb-status"></p>
        <div class="fb-popup__actions">
            <button type="button" class="btn btn-secondary" id="fb-cancel">Cancel</button>
            <button type="button" class="btn btn-primary" id="fb-submit">Submit</button>
        </div>
    `, { title: "Send Feedback" });

    const textarea = overlay.querySelector("#fb-message");
    const category = overlay.querySelector("#fb-category");
    const status = overlay.querySelector("#fb-status");
    const submitBtn = overlay.querySelector("#fb-submit");
    const cancelBtn = overlay.querySelector("#fb-cancel");

    setTimeout(() => textarea.focus(), 50);
    cancelBtn.addEventListener("click", close);

    submitBtn.addEventListener("click", async () => {
        const message = textarea.value.trim();
        if (!message) {
            status.textContent = "Please write something before submitting.";
            status.className = "fb-status is-error";
            return;
        }
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitBtn.textContent = "Sending…";
        status.textContent = "";
        status.className = "fb-status";
        try {
            await submitFeedback({ message, category: category.value });
            status.textContent = "Thank you for your feedback!";
            status.className = "fb-status is-ok";
            textarea.value = "";
            setTimeout(close, 1200);
        } catch (err) {
            console.error("submit feedback failed:", err);
            status.textContent = err.message || "Failed to send feedback. Please try again.";
            status.className = "fb-status is-error";
            submitBtn.disabled = false;
            cancelBtn.disabled = false;
            submitBtn.textContent = "Submit";
        }
    });
}

/* ---------------- bootstrap ---------------------------------------------- */
function fab(icon, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fab";
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.innerHTML = `<i data-lucide="${icon}"></i>`;
    btn.addEventListener("click", onClick);
    return btn;
}

const row = document.createElement("div");
row.className = "fab-row";
row.appendChild(fab("info", "About", showAboutPopup));
row.appendChild(fab("clock", "Why is this slow?", showSlowPopup));
row.appendChild(fab("message-circle", "Feedback", showFeedbackPopup));
document.body.appendChild(row);
if (window.lucide) lucide.createIcons();
