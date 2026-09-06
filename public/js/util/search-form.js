// Wires up a "search box + button" pair that is deliberately NOT a <form> —
// see player.html/club.html/compare.html for why: a <form> element is the
// strongest remaining signal Chrome's Autofill uses to decide a plain text
// input might be a payment/address field, and switching the input itself to
// type="search" (982967e) didn't fully stop it in practice. Enter-to-submit
// and click-to-submit are wired here instead of relying on native <form>
// submission.
export function bindSearchForm(containerId, inputId, onSubmit) {
    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    const fire = () => onSubmit(input.value);
    container.querySelector("button").addEventListener("click", fire);
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") fire();
    });
}
