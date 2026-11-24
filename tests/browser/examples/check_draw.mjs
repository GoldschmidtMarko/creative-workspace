// Smoke-test the tournament page's Draw tab against the local emulators.
//
//   node tests/browser/examples/check_draw.mjs [tournamentId] [disciplineName] [outDir]
//
// Opens the tournament on its Draw tab, picks the discipline whose chip text
// matches, waits for the bracket (and, if it arrives within the timeout, the
// BAX values), clicks the lowest-rated entry to trace its path, then takes
// desktop + phone screenshots. Picking a discipline runs that discipline's
// BAX analysis (live scraping on a cold cache) — reuse one tournament id per
// session (see .claude/rules/testing.md).
import { mkdirSync } from "node:fs";
import { launchBrowser, newPageWithErrorLog } from "../driver.mjs";

const HOST = "http://127.0.0.1:5000";
const tid = process.argv[2] || "04DCFC58-4E06-4A15-923E-2C89401F70EF";   // HOLZLAND MASTERS VII 2026 (finished, KO draws)
const discName = process.argv[3] || "HE A";
const outDir = process.argv[4] || "tests/browser/.out/draw";
mkdirSync(outDir, { recursive: true });

const browser = await launchBrowser();
for (const [vp, width, height] of [["desktop", 1360, 1000], ["phone", 390, 844]]) {
    const { page, errors } = await newPageWithErrorLog(browser, { viewport: { width, height } });
    await page.goto(`${HOST}/html/tournament.html?id=${tid}&view=draw`, { waitUntil: "networkidle" });
    await page.waitForSelector(".disc-chip__select", { timeout: 60000 });
    const chip = page.locator(".disc-chip__select", { hasText: new RegExp(`^\\s*${discName}\\s*$`) }).first();
    await chip.click();
    await page.waitForSelector(".dr-bracket, .dr-msg", { timeout: 60000 });
    try {
        await page.waitForFunction(() => document.querySelector(".dr-slot .bx"), null, { timeout: 240000 });
        console.log(`[${vp}] bracket shows BAX values`);
    } catch {
        console.log(`[${vp}] BAX values did not arrive in time — screenshot shows the bare bracket`);
    }
    const slots = await page.$$eval(".dr-bracket .dr-slot.is-team", (els) => els.length);
    console.log(`[${vp}] ${slots} team slots rendered`);
    const last = page.locator(".dr-bracket .dr-slot.is-team").nth(5);
    if (await last.count()) await last.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${outDir}/draw-${vp}.png`, fullPage: vp === "desktop" });
    console.log(`[${vp}] errors:`, errors.length ? errors : "(none)");
    await page.context().close();
}
await browser.close();
