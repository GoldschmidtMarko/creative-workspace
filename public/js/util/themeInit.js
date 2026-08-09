// Runs first in <head>, synchronously before paint. Two jobs:
//   1) Canonical host — bounce Firebase's default domains to the custom domain.
//   2) Apply the saved / preferred theme (avoids a flash of the wrong theme).
(function () {
    // 1) Canonical-host redirect. Firebase serves the same site on
    // *.web.app / *.firebaseapp.com and on the custom domain; send visitors to
    // the canonical one so the address bar shows baxcheck.de. Localhost (dev)
    // and the custom domain itself don't match, so they're left alone.
    try {
        var host = location.hostname;
        if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
            location.replace('https://baxcheck.de' + location.pathname + location.search + location.hash);
            return; // navigating away — skip the rest
        }
    } catch (e) { /* ignore and continue to theme */ }

    // 2) Theme before paint.
    try {
        var stored = localStorage.getItem('creative-workspace-theme');
        var theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();
