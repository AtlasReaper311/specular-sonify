import assert from "node:assert/strict";
import test from "node:test";

import { SERVICES, deriveEstate, deriveServices } from "../src/index.js";

const NOW = Date.parse("2026-07-16T10:30:48.000Z");

function facts(overrides = {}) {
  return {
    stats: {
      ok: true,
      generated_at: "2026-07-16T10:30:49.000Z",
      estate: {
        checked_at: "2026-07-16T10:30:48.000Z",
        components: {
          registry: true,
          notify: true,
          specular: false,
          specular_edge: true,
          corpus: false,
          machine: true,
          ramone_trigger: false,
          github_pulse: true,
          site_pulse: true,
          deploy_watch: true,
        },
      },
      uptime: {
        components: {
          registry: 100,
          notify: 100,
          specular: 42.69,
          specular_edge: 100,
          corpus: 42.91,
          machine: 43.64,
          ramone_trigger: 100,
          github_pulse: 99.81,
          site_pulse: 100,
          deploy_watch: 100,
        },
      },
    },
    infra: { stale: true, components: {} },
    apiLatencyMs: 18,
    ...overrides,
  };
}

test("the contract exposes eleven exact, stable service identities", () => {
  assert.deepEqual(SERVICES, [
    "ramone-memory",
    "atlas-corpus",
    "specular-telemetry",
    "atlas-api-public",
    "atlas-api-index",
    "atlas-notify",
    "ramone-trigger",
    "specular-edge",
    "github-pulse",
    "site-pulse",
    "deploy-watch",
  ]);
  assert.deepEqual(
    deriveServices(null, NOW, 1200, facts()).map((service) => service.name),
    SERVICES,
  );
});

test("current stats expand honest coverage and use dedicated component facts", () => {
  const services = deriveServices(null, NOW, 1200, facts());
  const byName = new Map(services.map((service) => [service.name, service]));
  assert.equal(byName.get("atlas-api-public").status, "healthy");
  assert.equal(byName.get("atlas-api-public").latency_ms, 18);
  assert.equal(byName.get("atlas-notify").status, "healthy");
  assert.equal(byName.get("ramone-trigger").status, "down");
  assert.equal(byName.get("specular-edge").status, "healthy");
  assert.equal(byName.get("github-pulse").uptime_pct, null);
  assert.equal(byName.get("ramone-trigger").uptime_pct, 100);
  assert.match(byName.get("ramone-trigger").evidence_source, /stats.*ramone_trigger/);
  assert.equal(byName.get("ramone-trigger").measured_at, "2026-07-16T10:30:48.000Z");
});

test("stale infra is ignored in favour of the newer estate probe", () => {
  const services = deriveServices(null, NOW, 1200, facts({
    infra: {
      stale: true,
      components: {
        ollama: { ok: false, latency_ms: 999 },
        corpus_health: { ok: true, latency_ms: 2 },
      },
    },
  }));
  const byName = new Map(services.map((service) => [service.name, service]));
  assert.equal(byName.get("ramone-memory").status, "healthy");
  assert.equal(byName.get("ramone-memory").latency_ms, null);
  assert.equal(byName.get("atlas-corpus").status, "down");
  assert.equal(byName.get("atlas-corpus").latency_ms, null);
  assert.match(byName.get("ramone-memory").evidence_source, /stats.*machine/);
});

test("fresh infra supplies the more specific local evidence", () => {
  const services = deriveServices(null, NOW, 1200, facts({
    infra: {
      stale: false,
      last_report_at: "2026-07-16T10:30:40.000Z",
      components: {
        ollama: { ok: true, latency_ms: 31 },
        corpus_health: { ok: true, latency_ms: 40 },
        corpus_search: { ok: false, latency_ms: 60 },
      },
    },
  }));
  const byName = new Map(services.map((service) => [service.name, service]));
  assert.equal(byName.get("ramone-memory").status, "healthy");
  assert.equal(byName.get("ramone-memory").latency_ms, 31);
  assert.equal(byName.get("atlas-corpus").status, "degraded");
  assert.equal(byName.get("atlas-corpus").latency_ms, 50);
  assert.match(byName.get("atlas-corpus").evidence_source, /infra\/status/);
});

test("an old stats snapshot is measured unknown, not current health", () => {
  const staleStats = facts();
  staleStats.stats.estate.checked_at = "2026-07-16T09:00:00.000Z";
  const services = deriveServices(null, NOW, 1200, staleStats);
  const byName = new Map(services.map((service) => [service.name, service]));
  assert.equal(byName.get("atlas-api-public").status, "healthy");
  assert.equal(byName.get("atlas-notify").status, "unknown");
  assert.equal(byName.get("ramone-trigger").status, "unknown");
  assert.equal(byName.get("atlas-notify").measured_at, "2026-07-16T09:00:00.000Z");
});

test("missing evidence fails closed to unknown and a null estate health", () => {
  const services = deriveServices(null, NOW, 1200, {
    stats: null,
    infra: null,
    apiLatencyMs: null,
  });
  assert.equal(services.length, 11);
  assert.ok(services.every((service) => service.status === "unknown"));
  assert.ok(services.every((service) => service.evidence_source === null));
  assert.deepEqual(deriveEstate(services), {
    overall_health: null,
    active_incidents: 0,
  });
});
