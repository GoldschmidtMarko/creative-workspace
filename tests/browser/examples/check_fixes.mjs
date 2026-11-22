// Verifies: player relative-standing marker/highlight, tournament discipline
// detection ("BM HE" -> Einzel), mobile footer-docked feedback buttons.
//   node tests/browser/examples/check_fixes.mjs <outdir>
import { launchBrowser, newPageWithErrorLog } from "../driver.mjs";
const HOST = "http://127.0.0.1:5000", out = process.argv[2] || "tests/browser/.out";
const browser = await launchBrowser();

let { page, errors } = await newPageWithErrorLog(browser, { viewport: { width: 1280, height: 900 } });
await page.goto(`${HOST}/html/player.html?sp=10-011898&pid=09245C97-7181-4A39-8455-E52193285956&name=Valentin+Himmel#rating`, { waitUntil: "networkidle" });
await page.waitForSelector("#dist-body .pl-bar", { timeout: 60000 });
console.log("player:", await page.evaluate(() => ({
  me: [...document.querySelectorAll("#dist-body .pl-bar--me")].map((r) => r.dataset.tip),
  label: document.querySelector("#dist-body .pl-marker-label")?.textContent,
})));
await page.locator("#dist-body").screenshot({ path: `${out}/dist.png` });

({ page } = await newPageWithErrorLog(browser, { viewport: { width: 390, height: 800 } }));
await page.goto(`${HOST}/html/tournament.html?id=0F5AE6AA-8888-4B89-A968-6897CD36BE9B&event=6&name=BM+O19`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".tm__val", { timeout: 300000 });
console.log("tournament vals:", await page.$$eval(".tm", (els) => els.filter((e) => e.textContent.includes("Nowak")).map((e) => e.textContent)));
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(400);
console.log("fab docked in footer:", await page.evaluate(() => !!document.querySelector(".site-footer .fab-row--docked")));
await page.screenshot({ path: `${out}/mobile.png` });
console.log("errors:", errors);
await browser.close();
