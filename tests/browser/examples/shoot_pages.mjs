// Screenshot a set of pages at desktop and phone width, in light and dark,
// against the local hosting emulator — for checking visual/layout changes.
//
//   node tests/browser/examples/shoot_pages.mjs [outDir] [path ...]
//
// Paths are relative to the hosting emulator (default: the main entry pages).
// Each page waits for the network to settle, so pages that call live
// scraping callables will make those calls — keep the list short and reuse
// ids that are already cached in the Firestore emulator (see
// .claude/rules/testing.md).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { launchBrowser } from "../driver.mjs";

const HOST = "http://127.0.0.1:5000";
const outDir = process.argv[2] || "tests/browser/.out/pages";
const paths = process.argv.length > 3 ? process.argv.slice(3) : [
    "/html/index.html",
    "/html/tournaments.html",
    "/html/player.html",
];
const VIEWPORTS = [["desktop", 1360, 900], ["phone", 390, 844]];
const THEMES = ["light", "dark"];

mkdirSync(outDir, { recursive: true });
const browser = await launchBrowser();
const problems = [];
for (const p of paths) {
    const slug = p.replace(/^\/html\//, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
    for (const [vpName, width, height] of VIEWPORTS) {
        for (const theme of THEMES) {
            const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
            // The site reads its theme from localStorage before paint (themeInit.js).
            await ctx.addInitScript((t) => { try { localStorage.setItem("creative-workspace-theme", t); } catch (_) {} }, theme);
            const page = await ctx.newPage();
            page.on("pageerror", (e) => problems.push(`${p} [${vpName}/${theme}] pageerror: ${e.message}`));
            page.on("console", (m) => { if (m.type() === "error") problems.push(`${p} [${vpName}/${theme}] console: ${m.text()}`); });
            try {
                await page.goto(HOST + p, { waitUntil: "networkidle", timeout: 60000 });
            } catch (e) {
                problems.push(`${p} [${vpName}/${theme}] load: ${e.message.split("\n")[0]}`);
            }
            await page.waitForTimeout(600);
            if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
                problems.push(`${p} [${vpName}/${theme}] page scrolls horizontally`);
            }
            const file = path.join(outDir, `${slug}-${vpName}-${theme}.png`);
            await page.screenshot({ path: file, fullPage: vpName === "desktop" });
            await ctx.close();
        }
    }
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "no console errors, no horizontal overflow");
console.log("screenshots in", outDir);
