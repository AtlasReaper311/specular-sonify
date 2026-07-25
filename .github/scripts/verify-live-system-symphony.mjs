import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const reportPath = process.env.REPORT_PATH ?? "live-system-symphony-report.json";
const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
const pageErrors = [];
const requestFailures = [];
let stage = "launch";

page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("requestfailed", (request) => {
  const url = request.url();
  if (
    url.startsWith("https://api.atlas-systems.uk/")
    || url.includes("/vendor/tone.min.js")
    || url.includes("/static/audio/system-symphony/")
  ) {
    requestFailures.push({ url, error: request.failure()?.errorText ?? "unknown" });
  }
});

async function readState() {
  return page.evaluate(() => ({
    location: window.location.href,
    toneAvailable: Boolean(window.Tone),
    toneContextState: window.Tone?.getContext?.()?.rawContext?.state
      ?? window.Tone?.context?.rawContext?.state
      ?? window.Tone?.context?.state
      ?? null,
    source: document.getElementById("system-symphony-widget")?.dataset?.source ?? null,
    hostState: document.getElementById("system-symphony-widget")?.dataset?.state ?? null,
    running: document.getElementById("system-symphony-widget")?.dataset?.running ?? null,
    status: document.querySelector("[data-important-status]")?.textContent?.trim() ?? null,
    sourceBadge: document.querySelector("[data-source-badge]")?.textContent?.trim() ?? null,
    buttons: [...document.querySelectorAll("[data-audio-toggle]")].map((button) => ({
      text: button.textContent?.trim() ?? "",
      pressed: button.getAttribute("aria-pressed"),
      disabled: button.disabled,
      visible: Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length),
    })),
  })).catch((error) => ({ evaluateError: error.message }));
}

async function writeReport(report) {
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

try {
  stage = "navigation";
  const response = await page.goto("https://atlas-systems.uk/lab/system-symphony/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.ok(response?.ok(), `System Symphony answered ${response?.status() ?? "no response"}`);

  stage = "interface-ready";
  await page.waitForFunction(() => (
    Boolean(window.Tone)
    && document.getElementById("system-symphony-widget")?.dataset?.source === "live"
    && [...document.querySelectorAll("[data-audio-toggle]")].some((button) => (
      Boolean(button.offsetWidth || button.offsetHeight || button.getClientRects().length)
      && button.disabled === false
    ))
  ), null, { timeout: 45_000 });

  stage = "start-control";
  const button = page.locator("[data-audio-toggle]:visible").first();
  await button.click();

  stage = "audio-running";
  await page.waitForFunction(() => (
    document.getElementById("system-symphony-widget")?.dataset?.running === "1"
    && [...document.querySelectorAll("[data-audio-toggle]")].some((node) => (
      node.getAttribute("aria-pressed") === "true" && /stop/i.test(node.textContent ?? "")
    ))
  ), null, { timeout: 45_000 });

  stage = "full-sample-library";
  await page.waitForFunction(() => {
    const status = document.querySelector("[data-important-status]")?.textContent?.trim() ?? "";
    return /^Full hybrid instrument ready: 38\/38 assets\.$/.test(status);
  }, null, { timeout: 90_000 });

  stage = "assertions";
  const state = await readState();
  assert.equal(state.source, "live", JSON.stringify(state, null, 2));
  assert.equal(state.sourceBadge, "LIVE", JSON.stringify(state, null, 2));
  assert.equal(state.running, "1", JSON.stringify(state, null, 2));
  assert.equal(state.status, "Full hybrid instrument ready: 38/38 assets.", JSON.stringify(state, null, 2));
  assert.equal(state.toneContextState, "running", JSON.stringify(state, null, 2));
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(requestFailures.length, 0, JSON.stringify(requestFailures, null, 2));

  const report = { ok: true, stage, state, pageErrors, requestFailures };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = {
    ok: false,
    failedStage: stage,
    error: { name: error.name, message: error.message },
    state: await readState(),
    pageErrors,
    requestFailures,
  };
  await writeReport(report);
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
