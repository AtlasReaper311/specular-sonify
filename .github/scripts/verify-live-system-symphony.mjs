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
    debugEngine: Boolean(window.__symphonyEngine),
    source: document.getElementById("system-symphony-widget")?.dataset?.source ?? null,
    hostState: document.getElementById("system-symphony-widget")?.dataset?.state ?? null,
    sampleReady: window.__symphonyEngine?.isSampleReady?.() ?? false,
    sampleStats: window.__symphonyEngine?.getSampleLoadStats?.() ?? null,
    status: document.querySelector("[data-important-status]")?.textContent?.trim() ?? null,
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
  const response = await page.goto("https://atlas-systems.uk/lab/system-symphony/?symphonyDebug=1", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  assert.ok(response?.ok(), `System Symphony answered ${response?.status() ?? "no response"}`);

  stage = "engine-ready";
  await page.waitForFunction(() => Boolean(window.Tone) && Boolean(window.__symphonyEngine), null, { timeout: 30_000 });

  stage = "start-control";
  const button = page.locator("[data-audio-toggle]:visible").first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await button.click();

  stage = "audio-running";
  await page.waitForFunction(() => (
    [...document.querySelectorAll("[data-audio-toggle]")].some((node) => (
      node.getAttribute("aria-pressed") === "true" && /stop/i.test(node.textContent ?? "")
    ))
  ), null, { timeout: 45_000 });

  stage = "core-samples";
  await page.waitForFunction(() => window.__symphonyEngine?.isSampleReady?.() === true, null, { timeout: 45_000 });

  stage = "full-sample-library";
  await page.waitForFunction(() => window.__symphonyEngine?.getSampleLoadStats?.()?.backgroundComplete === true, null, { timeout: 90_000 });

  stage = "assertions";
  const state = await readState();
  const report = { ok: true, stage, state, pageErrors, requestFailures };
  await writeReport(report);
  console.log(JSON.stringify(report, null, 2));
  assert.equal(state.source, "live", JSON.stringify(state, null, 2));
  assert.equal(state.sampleReady, true, JSON.stringify(state, null, 2));
  assert.equal(state.sampleStats?.failed, 0, JSON.stringify(state, null, 2));
  assert.equal(state.sampleStats?.loaded, state.sampleStats?.totalAssets, JSON.stringify(state, null, 2));
  assert.equal(pageErrors.length, 0, pageErrors.join("\n"));
  assert.equal(requestFailures.length, 0, JSON.stringify(requestFailures, null, 2));
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
