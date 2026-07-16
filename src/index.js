/**
 * specular-sonify
 *
 * The estate reshaped for ears: one read-only endpoint that turns what
 * TELEMETRY_KV knows into the fixed /sonify contract the sonification
 * frontend consumes. Deliberately decoupled from specular-edge (own
 * repo, own deploy lifecycle) and deliberately writeless: it reads the
 * snapshot specular-edge maintains and never touches KV otherwise,
 * which satisfies the estate's conditional-KV-write rule by the
 * strongest possible means.
 *
 * Honesty over completeness: TELEMETRY_KV still owns the specular
 * hardware snapshot, while atlas-api-public already owns live estate
 * stats, measured uptime, and sentinel latencies. This Worker reads
 * both public facts and reshapes them into one fixed audio frame; when
 * a source is absent, the affected fields stay null rather than being
 * invented. The derivation lives in adapter functions so richer
 * per-service keys can slot in later without touching the route
 * handler. See README for the coverage table.
 */

import { handleMeta } from "./_meta.js";

/** Written by specular-edge; this Worker only ever reads it. */
const KV_KEY = "specular:last-known-good:v1";
const DEFAULT_PUBLIC_API_BASE = "https://api.atlas-systems.uk/v1";

/**
 * The curated service list has a fixed order and bounded size,
 * regardless of traffic or data volume. Every entry has a current
 * evidence owner; topology-only components remain outside this list
 * until an equally defensible source exists.
 */
export const SERVICES = [
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
];

/** Status scores for the overall_health mean. Unknown is excluded
 *  rather than scored: no data is not the same as bad data. */
const STATUS_SCORE = { healthy: 1, degraded: 0.5, down: 0 };

const META = {
  name: "specular-sonify",
  description:
    "Estate health reshaped into the /sonify frame the sonification engine plays",
  version: "1.1.0",
  endpoints: [
    {
      method: "GET",
      path: "/sonify",
      description:
        "Current estate frame: overall health, active incidents, eleven evidence-backed services",
    },
    { method: "GET", path: "/sonify/_meta", description: "This document" },
  ],
  source: "https://github.com/AtlasReaper311/specular-sonify",
};

/** Build CORS headers for an allowlisted browser origin (same pattern
 *  as specular-edge, same ALLOWED_ORIGINS shape). */
function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const headers = { vary: "origin" };
  if (!origin) return headers;
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (allowed.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, OPTIONS";
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-max-age"] = "86400";
  }
  return headers;
}

/** JSON response with CORS and optional extra headers. */
function json(body, request, env, { status = 200, cacheControl } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders(request, env),
  };
  if (cacheControl) headers["cache-control"] = cacheControl;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Read the snapshot defensively. A malformed value is treated as
 * missing (and logged) rather than thrown: a sonification API that
 * 500s on one bad KV write is a worse monitor than one that says
 * "unknown".
 */
async function readSnapshot(env) {
  try {
    return await env.TELEMETRY_KV.get(KV_KEY, "json");
  } catch (err) {
    console.log("sonify: snapshot unreadable:", err.message);
    return null;
  }
}

async function fetchJson(fetcher, url) {
  const started = Date.now();
  try {
    const res = await fetcher.fetch(url, {
      headers: { "user-agent": "specular-sonify/1.1" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return {
        ok: false,
        latency_ms: Date.now() - started,
        body: null,
      };
    }
    return {
      ok: true,
      latency_ms: Date.now() - started,
      body: await res.json(),
    };
  } catch (err) {
    console.log("sonify: upstream unreadable:", url, err.message);
    return { ok: false, latency_ms: null, body: null };
  }
}

async function readPublicFacts(env) {
  const hasBinding =
    env.ATLAS_PUBLIC && typeof env.ATLAS_PUBLIC.fetch === "function";
  const fetcher = hasBinding ? env.ATLAS_PUBLIC : globalThis;
  const base = hasBinding
    ? "https://atlas-api-public/v1"
    : (env.PUBLIC_API_BASE || DEFAULT_PUBLIC_API_BASE).replace(/\/$/, "");
  const [stats, infra] = await Promise.all([
    fetchJson(fetcher, `${base}/stats`),
    fetchJson(fetcher, `${base}/infra/status`),
  ]);
  return {
    stats: stats.ok ? stats.body : null,
    infra: infra.ok ? infra.body : null,
    apiLatencyMs: stats.latency_ms,
  };
}

/** A service record with no measurements. The contract's null rule:
 *  present in the list, status set, every numeric field null. */
function nullService(name, status) {
  return {
    name,
    status,
    evidence_source: null,
    measured_at: null,
    latency_ms: null,
    uptime_pct: null,
    error_rate: null,
    last_deploy_secs_ago: null,
  };
}

function service(name, status, fields = {}) {
  return {
    ...nullService(name, status),
    ...fields,
  };
}

function boolStatus(value) {
  if (value === true) return "healthy";
  if (value === false) return "down";
  return "unknown";
}

function infraStatus(infra, checkNames) {
  if (!infra || infra.stale === true) return "unknown";
  const checks = checkNames
    .map((name) => infra.components?.[name])
    .filter(Boolean);
  if (!checks.length) return "unknown";
  const passing = checks.filter((check) => check.ok === true).length;
  if (passing === checks.length) return "healthy";
  if (passing === 0) return "down";
  return "degraded";
}

function averageLatency(infra, checkNames) {
  const values = checkNames
    .map((name) => infra?.components?.[name]?.latency_ms)
    .filter((value) => Number.isFinite(value));
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function uptime(stats, component) {
  const value = stats?.uptime?.components?.[component];
  return Number.isFinite(value) ? value : null;
}

function currentUptime(stats, component, status) {
  // The public uptime window includes normal homelab sleep. When the
  // current probe is healthy, feeding that historical duty cycle into
  // the audio filter makes a live system sound broken. Keep the filter
  // open for current health; use measured uptime only when the current
  // status is already degraded or down.
  return status === "healthy" ? null : uptime(stats, component);
}

function statsMeasuredAt(stats) {
  return stats?.estate?.checked_at ?? stats?.generated_at ?? null;
}

function timestampIsFresh(value, nowMs, staleAfterSecs) {
  const measuredAtMs = Date.parse(value ?? "");
  return Number.isFinite(measuredAtMs)
    && nowMs - measuredAtMs <= staleAfterSecs * 1000;
}

function statsService(
  name,
  component,
  stats,
  nowMs,
  staleAfterSecs,
  fields = {},
) {
  if (stats?.ok !== true) return nullService(name, "unknown");
  const measuredAt = statsMeasuredAt(stats);
  const status = timestampIsFresh(measuredAt, nowMs, staleAfterSecs)
    ? boolStatus(stats.estate?.components?.[component])
    : "unknown";
  return service(name, status, {
    evidence_source:
      `atlas-api-public:/v1/stats#estate.components.${component}`,
    measured_at: measuredAt,
    uptime_pct: currentUptime(stats, component, status),
    ...fields,
  });
}

function freshInfraService(name, infra, checkNames, stats, uptimeComponent) {
  if (!infra || infra.stale === true) return null;
  const status = infraStatus(infra, checkNames);
  if (status === "unknown") return null;
  return service(name, status, {
    evidence_source:
      `atlas-api-public:/v1/infra/status#components.${checkNames.join("+")}`,
    measured_at: infra.last_report_at ?? null,
    latency_ms: averageLatency(infra, checkNames),
    uptime_pct: currentUptime(stats, uptimeComponent, status),
  });
}

/**
 * The adapter: one hardware snapshot plus public estate facts in, eleven
 * contract records out. Everything the sources can honestly say, and
 * nothing they cannot:
 *
 *   specular-telemetry  online:true + fresh saved_at -> healthy
 *                       online:true + stale saved_at -> degraded
 *                         (the machine claims life but the write path
 *                          has wedged somewhere; either way, suspect)
 *                       online:false                 -> down
 *                         (the machine sleeping is normal estate life
 *                          and is reported plainly as down; the sound
 *                          design treats it as state, not emergency)
 *   specular-edge       the dedicated specular_edge estate probe reports
 *                       Worker reachability independently of whether the
 *                       downstream telemetry machine is awake.
 * Public stats add current probe verdicts and measured uptime for ten
 * estate components. Infra status adds more specific local latencies
 * for Ollama and corpus only while that report is fresh.
 * Error-rate and deploy history are still null because no source owns
 * those facts yet; the frontend's per-status null defaults own what
 * that sounds like.
 */
export function deriveServices(snapshot, nowMs, staleAfterSecs, facts = {}) {
  const { stats, infra, apiLatencyMs } = facts;
  return SERVICES.map((name) => {
    if (name === "ramone-memory") {
      return freshInfraService(name, infra, ["ollama"], stats, "machine")
        ?? statsService(name, "machine", stats, nowMs, staleAfterSecs);
    }
    if (name === "atlas-corpus") {
      return freshInfraService(
        name,
        infra,
        ["corpus_health", "corpus_search"],
        stats,
        "corpus",
      ) ?? statsService(name, "corpus", stats, nowMs, staleAfterSecs);
    }
    if (name === "specular-telemetry") {
      if (!snapshot) {
        return statsService(name, "specular", stats, nowMs, staleAfterSecs);
      }
      if (snapshot.online === false) {
        return service(name, "down", {
          evidence_source: `TELEMETRY_KV:${KV_KEY}`,
          measured_at: snapshot.saved_at ?? null,
          uptime_pct: uptime(stats, "specular"),
        });
      }
      const savedAtMs = Date.parse(snapshot.saved_at ?? "");
      const fresh =
        Number.isFinite(savedAtMs) &&
        nowMs - savedAtMs <= staleAfterSecs * 1000;
      const status = fresh ? "healthy" : "degraded";
      return service(name, status, {
        evidence_source: `TELEMETRY_KV:${KV_KEY}`,
        measured_at: snapshot.saved_at ?? null,
        uptime_pct: currentUptime(stats, "specular", status),
      });
    }
    if (name === "atlas-api-public") {
      return stats?.ok === true
        ? service(name, "healthy", {
            evidence_source: "atlas-api-public:/v1/stats request",
            measured_at: stats.generated_at ?? statsMeasuredAt(stats),
            latency_ms: Number.isFinite(apiLatencyMs) ? apiLatencyMs : null,
          })
        : nullService(name, "unknown");
    }
    if (name === "atlas-api-index") {
      return statsService(name, "registry", stats, nowMs, staleAfterSecs);
    }
    if (name === "atlas-notify") {
      return statsService(name, "notify", stats, nowMs, staleAfterSecs);
    }
    if (name === "ramone-trigger") {
      return statsService(name, "ramone_trigger", stats, nowMs, staleAfterSecs);
    }
    if (name === "specular-edge") {
      return statsService(name, "specular_edge", stats, nowMs, staleAfterSecs);
    }
    if (name === "github-pulse") {
      return statsService(name, "github_pulse", stats, nowMs, staleAfterSecs);
    }
    if (name === "site-pulse") {
      return statsService(name, "site_pulse", stats, nowMs, staleAfterSecs);
    }
    if (name === "deploy-watch") {
      return statsService(name, "deploy_watch", stats, nowMs, staleAfterSecs);
    }
    return nullService(name, "unknown");
  });
}

/**
 * Estate rollup. overall_health is the mean status score over services
 * with data; an all-unknown estate reads as null rather than quietly
 * claiming health. active_incidents counts services that are down.
 */
export function deriveEstate(services) {
  const known = services.filter((s) => s.status !== "unknown");
  const health = known.length
    ? known.reduce((sum, s) => sum + STATUS_SCORE[s.status], 0) / known.length
    : null;
  return {
    overall_health: health === null ? null : Math.round(health * 1000) / 1000,
    active_incidents: services.filter((s) => s.status === "down").length,
  };
}

async function serveSonify(request, env) {
  const nowMs = Date.now();
  const staleAfterSecs = Number(env.STALE_AFTER_SECONDS || "1200");
  const [snapshot, facts] = await Promise.all([
    readSnapshot(env),
    readPublicFacts(env),
  ]);
  const services = deriveServices(snapshot, nowMs, staleAfterSecs, facts);
  const payload = {
    timestamp: new Date(nowMs).toISOString(),
    estate: deriveEstate(services),
    services,
  };
  // no-store: the payload is small and bounded, and the whole point is
  // liveness. Nothing here is worth a
  // cache layer, and the spec's conditional-KV pattern is moot because
  // this Worker performs zero writes of any kind.
  return json(payload, request, env, { cacheControl: "no-store" });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const meta = handleMeta(url, META);
    if (meta) return meta;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (request.method !== "GET") {
      return json(
        { error: "method not allowed" },
        request,
        env,
        { status: 405 },
      );
    }

    // Route pattern is api.atlas-systems.uk/sonify*, so the only valid
    // paths here are /sonify itself and /sonify/_meta (handled above).
    if (url.pathname === "/sonify" || url.pathname === "/sonify/") {
      return serveSonify(request, env);
    }

    return json({ error: "not found" }, request, env, { status: 404 });
  },
};
