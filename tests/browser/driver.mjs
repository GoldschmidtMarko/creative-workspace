// Reusable Playwright driver for manually smoke-testing BAX Checker pages
// against the local Firebase emulators (see ../README.md for setup).
//
// Always launches with an explicit, auto-discovered Chromium executablePath
// instead of relying on Playwright's own bundled-browser resolution — the
// browser revision a given playwright version expects and whatever's
// actually cached under ~/.cache/ms-playwright often drift apart (confirmed
// live: playwright 1.63.0 wanted chromium_headless_shell-1243, only
// chromium-1234 was on disk). Pinning executablePath sidesteps that
// entirely, regardless of which playwright version ends up installed.
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function loadPlaywright() {
    try {
        return await import("playwright");
    } catch {
        // Fall back to whatever playwright a plain `npx playwright ...`
        // has already cached globally, so this still works before
        // `npm install` has been run in this directory.
        const npxRoot = path.join(os.homedir(), ".npm", "_npx");
        if (existsSync(npxRoot)) {
            for (const dir of readdirSync(npxRoot)) {
                const candidate = path.join(npxRoot, dir, "node_modules", "playwright", "index.js");
                if (existsSync(candidate)) return import(candidate);
            }
        }
        throw new Error(
            "playwright not found. Run `npm install` in tests/browser, " +
            "or `npx playwright --version` once to warm the global npx cache."
        );
    }
}

function findChromiumExecutable() {
    const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
    if (!existsSync(cacheDir)) return null;
    // Prefer a full Chromium build (chrome-linux64/chrome supports
    // headless:true directly) over a headless_shell-only cache entry.
    const builds = readdirSync(cacheDir)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => parseInt(b.split("-")[1], 10) - parseInt(a.split("-")[1], 10));
    for (const build of builds) {
        const exe = path.join(cacheDir, build, "chrome-linux64", "chrome");
        if (existsSync(exe)) return exe;
    }
    return null;
}

// launchBrowser({ headless: false, ...anyOtherLaunchOption })
export async function launchBrowser(opts = {}) {
    const { chromium } = await loadPlaywright();
    const executablePath = findChromiumExecutable();
    if (!executablePath) {
        console.warn("No cached Chromium build found under ~/.cache/ms-playwright — " +
            "falling back to Playwright's own resolution (may need `npx playwright install chromium`).");
    }
    return chromium.launch({
        args: ["--no-sandbox"],
        ...(executablePath ? { executablePath } : {}),
        ...opts,
    });
}

// Convenience: a page with console-error / pageerror collection wired up,
// since "did anything throw" is the first thing every smoke check asks.
export async function newPageWithErrorLog(browser, opts = {}) {
    const page = await browser.newPage(opts);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    return { page, errors };
}
