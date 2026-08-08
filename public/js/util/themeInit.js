// Apply the saved / preferred theme before paint to avoid a flash of the
// wrong theme. Loaded synchronously in <head> before any stylesheet.
(function () {
    try {
        var stored = localStorage.getItem('creative-workspace-theme');
        var theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        document.documentElement.setAttribute('data-theme', theme);
    } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
    }
})();
