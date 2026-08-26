// Wires every ".auth-gate__signin" button (see the .auth-gate styles in
// main.css) to trigger the same Google sign-in popup as the top-right nav
// button, instead of duplicating the Firebase Auth flow here. Event-delegated
// so it works for any number of gates on the page with no per-element setup.
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".auth-gate__signin");
    if (!btn) return;
    const authBtn = document.getElementById("auth-btn");
    if (authBtn) authBtn.click();
});
