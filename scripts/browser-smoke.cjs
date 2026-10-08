/* Set PLAYWRIGHT_MODULE and CHROME_PATH to use an existing browser installation. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");

(async () => {
  fs.mkdirSync("test-results", { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.APP_URL || "http://127.0.0.1:3000", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Create your first bond" }).click();
  await page
    .getByRole("button", { name: "Create bond", exact: true })
    .last()
    .click();
  await page
    .getByRole("heading", { name: "Kazakhstan Infrastructure Bond" })
    .waitFor();
  await page.getByRole("button", { name: "Schedule first action" }).click();
  await page
    .getByRole("button", { name: "Schedule action", exact: true })
    .click();
  await page.getByRole("button", { name: "Advance demo" }).click();
  await page.getByRole("button", { name: "Execute settlement" }).waitFor();
  await page.screenshot({
    path: "test-results/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Execute settlement" }).click();
  await page
    .getByText("Local settlement completed.", { exact: false })
    .waitFor();
  let state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("kase-flow-demo-v1")),
  );
  assert.equal(state.bond.holders[0].paid, "500000000");
  assert.equal(state.bond.actions[0].status, "completed");
  await page
    .getByRole("button", { name: "Schedule corporate action", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Early redemption", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Schedule action", exact: true })
    .click();
  await page.getByRole("button", { name: "Advance demo" }).click();
  await page.getByRole("button", { name: "Execute settlement" }).click();
  await page
    .getByText("Local settlement completed.", { exact: false })
    .waitFor();
  state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("kase-flow-demo-v1")),
  );
  assert.equal(state.bond.outstanding, "30");
  assert.deepEqual(
    state.bond.holders.map((h) => h.quantity),
    ["7", "15", "8"],
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("heading", { name: "Kazakhstan Infrastructure Bond" })
    .waitFor();
  await page
    .getByRole("button", { name: "Schedule corporate action", exact: true })
    .click();
  await page.getByRole("button", { name: "At maturity", exact: true }).click();
  await page
    .getByRole("button", { name: "Schedule action", exact: true })
    .click();
  await page.getByRole("button", { name: "Advance demo" }).click();
  await page.getByRole("button", { name: "Execute settlement" }).click();
  await page
    .getByText("Local settlement completed.", { exact: false })
    .waitFor();
  state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("kase-flow-demo-v1")),
  );
  assert.equal(state.bond.outstanding, "0");
  assert.equal(state.bond.treasury, "8000000000");
  assert.equal(
    state.bond.actions.filter((a) => a.status === "completed").length,
    3,
  );
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByLabel("Filter action history").selectOption("completed");
  assert.equal(await page.locator("tbody tr").count(), 3);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await (await downloadPromise).saveAs("test-results/demo-report.json");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/dashboard-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
    "No page-level horizontal overflow on mobile",
  );
  await page.getByLabel("Network mode").selectOption("devnet");
  await page.getByRole("button", { name: "Create your first bond" }).waitFor();
  await page.getByLabel("Network mode").selectOption("demo");
  await page.getByText("Redeemed", { exact: true }).waitFor();
  assert.deepEqual(errors, [], "No browser runtime errors");
  console.log(
    "Browser checks passed: three actions, exact balances, reload, export, history filter, network isolation, mobile layout.",
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
