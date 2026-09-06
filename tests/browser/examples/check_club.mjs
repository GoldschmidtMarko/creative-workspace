// Example / template: smoke-test the Club Overview page against the local
// emulators. Copy this pattern for a different page rather than growing
// this one script to cover everything.
//
// Run (from repo root, with `firebase emulators:start` already running):
//   node tests/browser/examples/check_club.mjs [cl_code]
import { launchBrowser, newPageWithErrorLog } from "../driver.mjs";

const clCode = process.argv[2] || "10-0790"; // BC Trier — has real multi-discipline BAX data
const HOST = "http://127.0.0.1:5000";

const browser = await launchBrowser();
const { page, errors } = await newPageWithErrorLog(browser, { viewport: { width: 1280, height: 900 } });

await page.goto(`${HOST}/html/club.html?cl_code=${clCode}`, { waitUntil: "networkidle" });
await page.waitForSelector(".club-roster tbody tr", { timeout: 20000 });
await page.waitForFunction(() => document.getElementById("c-stats").textContent.includes("Active"), { timeout: 30000 });
console.log("roster + stat tiles loaded OK");

await page.click('.subnav__tab[data-tab="teams"]');
// Scoped to #teams-body — a bare ".pl-empty" also matches the (hidden)
// #search-status element elsewhere on the page and never resolves.
await page.waitForSelector("#teams-body .club-team-grid, #teams-body .pl-empty", { timeout: 30000 });
console.log("teams tab loaded OK");

const shotPath = "tests/browser/.out/check_club.png";
await page.screenshot({ path: shotPath, fullPage: true });
console.log("screenshot:", shotPath);

console.log("console/page errors:", errors.length ? errors : "(none)");
await browser.close();
process.exit(errors.length ? 1 : 0);
