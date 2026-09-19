// Scroll affordance for a horizontally scrolling tab bar (player.html's
// .subnav — nine tabs, which overflow a phone AND a mid-width desktop). The
// bar itself hides its scrollbar, and the next tab often starts just past
// the edge, so nothing showed that there was more (feedback: "not visible to
// be scrollable"). This toggles a fade + chevron button at whichever edge
// still has tabs beyond it, scrolls when a chevron is tapped, and brings a
// newly-activated tab into view.
//
// Markup (see player.html): <div class="subnav-wrap"> containing the
// <nav class="subnav"> plus a .subnav-arrow--left and .subnav-arrow--right
// button. The arrows sit on the wrapper, NOT inside the scrolling nav — a
// `position: sticky` child of an overflowing flex row is clamped to the
// row's visible width, so it would scroll away with the content.
export function enhanceScrollTabs(wrap) {
    const nav = wrap.querySelector(".subnav");
    const left = wrap.querySelector(".subnav-arrow--left");
    const right = wrap.querySelector(".subnav-arrow--right");
    if (!nav || !left || !right) return { reveal() {}, update() {} };

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const behavior = () => (reduceMotion.matches ? "auto" : "smooth");
    const EDGE = 2;   // px of slack for fractional scroll positions

    function update() {
        const max = nav.scrollWidth - nav.clientWidth;
        left.classList.toggle("is-hidden", !(nav.scrollLeft > EDGE));
        right.classList.toggle("is-hidden", !(nav.scrollLeft < max - EDGE));
    }

    // Center `tab` unless it's already fully in view clear of the arrows.
    function reveal(tab, instant) {
        if (!tab || !nav.clientWidth) return;   // page section still hidden
        const pad = right.offsetWidth;
        const from = nav.scrollLeft, to = from + nav.clientWidth;
        const tabL = tab.offsetLeft, tabR = tabL + tab.offsetWidth;
        if (tabL >= from + (from > EDGE ? pad : 0) && tabR <= to - pad) return;
        const target = Math.max(0, tabL - (nav.clientWidth - tab.offsetWidth) / 2);
        nav.scrollTo({ left: target, behavior: instant ? "auto" : behavior() });
    }

    const page = (dir) => nav.scrollBy({ left: dir * nav.clientWidth * 0.7, behavior: behavior() });
    left.addEventListener("click", () => page(-1));
    right.addEventListener("click", () => page(1));
    nav.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(update);

    // The nav is 0px wide until the profile view is un-hidden: the first
    // time it has a real size, bring the tab a #hash deep-link activated
    // into view too (nothing else would, it ran while hidden).
    let sized = false;
    new ResizeObserver(() => {
        if (nav.clientWidth && !sized) {
            sized = true;
            reveal(nav.querySelector(".is-active"), true);
        }
        update();
    }).observe(nav);

    update();
    return { reveal, update };
}
