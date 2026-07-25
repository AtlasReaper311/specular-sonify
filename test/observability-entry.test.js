import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  addDoraToFrame,
  doraServiceFromStats,
} from "../src/observability-entry.js";

function statsFixture() {
  return {
    generated_at: "2026-07-25T12:00:00.000Z",
    estate: {
      components: { atlas_dora: true },
      component_details: {
        atlas_dora: {
          status: "healthy",
          detail: "health contract reports ok",
          latency_ms: 14,
          evidence_source: "service-binding:atlas-dora/dora/health",
          measured_at: "2026-07-25T12:00:00.000Z",
        },
      },
    },
    uptime: { components: { atlas_dora: null } },
  };
}

test("DORA stats become a bounded sonification service record", () => {
  assert.deepEqual(doraServiceFromStats(statsFixture()), {
    name: "atlas-dora",
    status: "healthy",
    health_detail: "health contract reports ok",
    evidence_source: "service-binding:atlas-dora/dora/health",
    measured_at: "2026-07-25T12:00:00.000Z",
    latency_ms: 14,
    uptime_pct: null,
    error_rate: null,
    last_deploy_secs_ago: null,
  });
});

test("DORA is inserted before the self-measured sonification service", () => {
  const payload = {
    timestamp: "2026-07-25T12:00:00.000Z",
    estate: { overall_health: 1, active_incidents: 0 },
    services: [
      { name: "atlas-api-public", status: "healthy" },
      { name: "specular-sonify", status: "healthy" },
      { name: "status", status: "healthy" },
    ],
  };

  const result = addDoraToFrame(payload, doraServiceFromStats(statsFixture()));
  assert.deepEqual(result.services.map((service) => service.name), [
    "atlas-api-public",
    "atlas-dora",
    "specular-sonify",
    "status",
  ]);
  assert.equal(result.estate.overall_health, 1);
  assert.equal(result.estate.active_incidents, 0);
});

test("a missing DORA measurement remains unknown rather than healthy", () => {
  const service = doraServiceFromStats({ estate: { components: {}, component_details: {} } });
  assert.equal(service.status, "unknown");
  assert.equal(service.health_detail, "DORA health evidence unavailable");
  assert.equal(service.evidence_source, null);
});

test("Wrangler delegates through the measured service composition entry", () => {
  const wrangler = readFileSync("wrangler.toml", "utf8");
  assert.match(wrangler, /main = "src\/observability-entry\.js"/);
  assert.match(wrangler, /binding = "ATLAS_PUBLIC"\nservice = "atlas-api-public"/);
});
