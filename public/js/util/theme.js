// Shared page chrome: render icons and wire the light/dark theme toggle.
// Loaded at the end of <body>, after Lucide and the page markup.
if (window.lucide) lucide.createIcons();

var themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
    themeToggle.addEventListener('click', function () {
        var current = document.documentElement.getAttribute('data-theme');
        var next = current === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        try { localStorage.setItem('creative-workspace-theme', next); } catch (e) {}
    });
}
