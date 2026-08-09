import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import worker from "../src/observability-entry.js";

const WRANGLER_PATH = new URL("../wrangler.toml", import.meta.url);
const PREVIEW_ORIGIN =
  "https://system-symphony-pr-43.atlas-systems-44t.pages.dev";
const UNLISTED_ORIGIN = "https://unlisted-preview.example.invalid";
const KV_KEY = "specular:last-known-good:v1";

function productionAllowedOriginsFromWrangler() {
  const text = readFileSync(WRANGLER_PATH, "utf8");
  // Production [vars] precedes [env.dev]; take the first ALLOWED_ORIGINS assignment.
  const match = text.match(/ALLOWED_ORIGINS\s*=\s*"([^"]+)"/);
  assert.ok(match, "wrangler.toml must declare ALLOWED_ORIGINS");
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function originAllowlistHas(origins, candidate) {
  // Exact-string membership only. Do not use substring checks on origin URLs;
  // CodeQL treats those as incomplete host sanitization.
  return new Set(origins).has(candidate);
}

function assertPreviewOriginAllowlisted(origins) {
  assert.ok(
    originAllowlistHas(origins, PREVIEW_ORIGIN),
    "historical preview origin from #14 must remain in production ALLOWED_ORIGINS"
  );
}

function createTelemetryKv() {
  return {
    async get(key) {
      assert.equal(key, KV_KEY);
      // CORS contract tests only need an empty snapshot; keep the binding
      // read-only and free of unused branches.
      return null;
    },
    async put() {
      throw new Error("TELEMETRY_KV.put must not be called by CORS contract tests");
    },
  };
}

function createAtlasPublic() {
  return {
    async fetch() {
      return new Response(JSON.stringify({ ok: true, estate: { components: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function createEnv(allowedOrigins) {
  return {
    ALLOWED_ORIGINS: allowedOrigins,
    STALE_AFTER_SECONDS: "1200",
    PUBLIC_API_BASE: "https://api.atlas-systems.uk/v1",
    TELEMETRY_KV: createTelemetryKv(),
    ATLAS_PUBLIC: createAtlasPublic(),
  };
}

async function invoke(path, { method = "GET", origin, env } = {}) {
  const headers = { accept: "application/json" };
  if (origin) headers.origin = origin;
  const request = new Request(`https://api.atlas-systems.uk${path}`, {
    method,
    headers,
  });
  return worker.fetch(request, env ?? createEnv(productionAllowedOriginsFromWrangler().join(",")), {});
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

test("wrangler production allowlist still includes the historical System Symphony preview origin", () => {
  assertPreviewOriginAllowlisted(productionAllowedOriginsFromWrangler());
});

test("historical System Symphony preview origin is echoed on GET /sonify", async () => {
  const previousFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("global fetch must not be used when ATLAS_PUBLIC is bound");
  };

  try {
    const response = await invoke("/sonify", { origin: PREVIEW_ORIGIN });
    const body = await readJson(response);

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      PREVIEW_ORIGIN
    );
    assert.equal(response.headers.get("vary"), "origin");
    assert.match(response.headers.get("content-type") || "", /application\/json/);
    assert.equal(typeof body.timestamp, "string");
    assert.ok(body.estate);
    assert.ok(Array.isArray(body.services));
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("historical preview origin receives the OPTIONS preflight contract", async () => {
  const response = await invoke("/sonify", {
    method: "OPTIONS",
    origin: PREVIEW_ORIGIN,
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    PREVIEW_ORIGIN
  );
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.equal(
    response.headers.get("access-control-allow-headers"),
    "content-type"
  );
  assert.equal(response.headers.get("access-control-max-age"), "86400");
  assert.equal(response.headers.get("vary"), "origin");
});

test("each production allowlisted origin is echoed by the Worker handler", async () => {
  for (const origin of productionAllowedOriginsFromWrangler()) {
    const response = await invoke("/sonify", { origin });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("vary"), "origin");
    const body = await readJson(response);
    assert.ok(body.estate);
    assert.ok(Array.isArray(body.services));
  }
});

test("unlisted origins do not receive Access-Control-Allow-Origin", async () => {
  const response = await invoke("/sonify", { origin: UNLISTED_ORIGIN });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "origin");
  const body = await readJson(response);
  assert.ok(body.estate);
});

test("OPTIONS for an unlisted origin omits Access-Control-Allow-Origin", async () => {
  const response = await invoke("/sonify", {
    method: "OPTIONS",
    origin: UNLISTED_ORIGIN,
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "origin");
});

test("non-vacuity: removing the historical preview origin fails the focused CORS lock", async () => {
  const original = readFileSync(WRANGLER_PATH, "utf8");
  const mutated = original.replace(`${PREVIEW_ORIGIN},`, "");
  assert.notEqual(original, mutated);
  writeFileSync(WRANGLER_PATH, mutated);

  try {
    const origins = productionAllowedOriginsFromWrangler();
    assert.equal(originAllowlistHas(origins, PREVIEW_ORIGIN), false);

    const env = createEnv(origins.join(","));
    const getResponse = await invoke("/sonify", {
      origin: PREVIEW_ORIGIN,
      env,
    });
    assert.equal(getResponse.headers.get("access-control-allow-origin"), null);

    const optionsResponse = await invoke("/sonify", {
      method: "OPTIONS",
      origin: PREVIEW_ORIGIN,
      env,
    });
    assert.equal(optionsResponse.headers.get("access-control-allow-origin"), null);

    assert.throws(
      () => assertPreviewOriginAllowlisted(origins),
      /historical preview origin from #14/
    );
  } finally {
    writeFileSync(WRANGLER_PATH, original);
  }

  assertPreviewOriginAllowlisted(productionAllowedOriginsFromWrangler());
  const restoredGet = await invoke("/sonify", { origin: PREVIEW_ORIGIN });
  assert.equal(
    restoredGet.headers.get("access-control-allow-origin"),
    PREVIEW_ORIGIN
  );
});
