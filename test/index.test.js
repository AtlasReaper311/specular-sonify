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
          atlas_badges: true,
          atlas_blackbox: true,
          atlas_dep_audit: true,
          atlas_doc_viewer: true,
          atlas_journey_watch: true,
          atlas_quota_watch: true,
          atlas_systems: true,
          ramone_edge: true,
          status_surface: true,
        },
        component_details: {
          atlas_badges: {
            status: "healthy",
            detail: "current main CI succeeded",
            evidence_source: "github-actions:AtlasReaper311/atlas-badges/workflows/ci.yml",
            measured_at: "2026-07-16T10:00:00.000Z",
            latency_ms: null,
          },
          atlas_blackbox: {
            status: "healthy",
            detail: "flight recorder reachable",
            evidence_source: "service-binding:atlas-blackbox/blackbox/health",
            measured_at: "2026-07-16T10:30:48.000Z",
            latency_ms: 12,
          },
          atlas_dep_audit: {
            status: "degraded",
            detail: "weekly audit running",
            evidence_source: "github-actions:AtlasReaper311/atlas-dep-audit/workflows/audit.yml",
            measured_at: "2026-07-16T10:25:00.000Z",
            latency_ms: null,
          },
          atlas_doc_viewer: {
            status: "healthy",
            detail: "http 200",
            evidence_source: "https://cv.atlas-systems.uk",
            measured_at: "2026-07-16T10:30:48.000Z",
            latency_ms: 24,
          },
          atlas_journey_watch: {
            status: "healthy",
            detail: "latest expected run succeeded",
            evidence_source: "github-actions:AtlasReaper311/atlas-journey-watch/workflows/journey-watch.yml",
            measured_at: "2026-07-16T09:17:00.000Z",
            latency_ms: null,
          },
          atlas_quota_watch: {
            status: "degraded",
            detail: "quota meter above warning threshold",
            evidence_source: "service-binding:atlas-quota-watch/quota",
            measured_at: "2026-07-16T10:30:48.000Z",
            latency_ms: 14,
          },
          atlas_systems: {
            status: "healthy",
            detail: "http 200",
            evidence_source: "https://atlas-systems.uk",
            measured_at: "2026-07-16T10:30:48.000Z",
            latency_ms: 20,
          },
          ramone_edge: {
            status: "healthy",
            detail: "edge reachable; local AI sleeping",
            evidence_source: "service-binding:ramone-edge/status",
            measured_at: "2026-07-16T10:30:45.000Z",
            latency_ms: 10,
          },
          status_surface: {
            status: "healthy",
            detail: "http 200",
            evidence_source: "https://status.atlas-systems.uk",
            measured_at: "2026-07-16T10:30:48.000Z",
            latency_ms: 22,
          },
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
    selfMeasuredAt: "2026-07-16T10:30:48.000Z",
    ...overrides,
  };
}

test("the contract exposes twenty-one exact, stable service identities", () => {
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
    "atlas-badges",
    "atlas-blackbox",
    "atlas-dep-audit",
    "atlas-doc-viewer",
    "atlas-journey-watch",
    "atlas-quota-watch",
    "atlas-systems",
    "ramone-edge",
    "specular-sonify",
    "status",
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
  assert.equal(byName.get("atlas-dep-audit").status, "degraded");
  assert.equal(byName.get("atlas-dep-audit").health_detail, "weekly audit running");
  assert.equal(byName.get("atlas-doc-viewer").latency_ms, 24);
  assert.equal(byName.get("specular-sonify").status, "healthy");
  assert.equal(byName.get("status").evidence_source, "https://status.atlas-systems.uk");
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
  assert.equal(byName.get("atlas-blackbox").status, "unknown");
  assert.equal(byName.get("specular-sonify").status, "healthy");
  assert.equal(byName.get("atlas-notify").measured_at, "2026-07-16T09:00:00.000Z");
});

test("missing evidence fails closed to unknown and a null estate health", () => {
  const services = deriveServices(null, NOW, 1200, {
    stats: null,
    infra: null,
    apiLatencyMs: null,
  });
  assert.equal(services.length, 21);
  assert.ok(services.every((service) => service.status === "unknown"));
  assert.ok(services.every((service) => service.evidence_source === null));
  assert.deepEqual(deriveEstate(services), {
    overall_health: null,
    active_incidents: 0,
  });
});
