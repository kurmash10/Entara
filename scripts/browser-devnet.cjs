const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const assert = require("node:assert/strict");
(async () => {
  const report = JSON.parse(fs.readFileSync(".local/chain-smoke.json", "utf8"));
  assert.equal(report.rpc, "https://api.devnet.solana.com");
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [];
  const baseUrl = process.env.APP_URL || "http://127.0.0.1:3000";
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("Network mode").selectOption("devnet");
  await page
    .getByText("Program verified on Devnet.", { exact: false })
    .waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Open an existing bond" }).click();
  await page.getByLabel("Bond account address").fill(report.bond);
  await page
    .getByRole("button", { name: "Open bond", exact: true })
    .last()
    .click();
  await page
    .getByRole("heading", { name: "Kazakhstan Infrastructure Bond" })
    .waitFor({ timeout: 60000 });
  await page.getByText("Redeemed", { exact: true }).waitFor();
  assert.equal(
    await page.locator(".metric").last().locator("strong").innerText(),
    "$42,000",
  );
  await page.screenshot({
    path: "test-results/devnet-dashboard.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  assert.equal(await page.locator("tbody tr").count(), 3);
  assert.equal(
    await page.getByRole("link", { name: "On-chain record" }).count(),
    3,
  );
  await page.goto(`${baseUrl}/?bond=${report.bond}`, {
    waitUntil: "networkidle",
  });
  await page.getByText("Redeemed", { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(await page.getByLabel("Network mode").inputValue(), "devnet");
  assert.deepEqual(errors, []);
  console.log(
    "Devnet browser verification passed: deployed program, on-chain restoration, exact paid total, 3 action records.",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
