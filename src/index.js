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
 * Honesty over completeness: TELEMETRY_KV today holds exactly one key
 * (specular:last-known-good:v1, a hardware snapshot), so only the two
 * specular services can be derived from it. The other four curated
 * services return status "unknown" with null numeric fields, exactly
 * as the contract specifies, rather than invented measurements. The
 * derivation lives in one adapter function so richer per-service keys
 * can slot in later without touching the route handler. See README
 * for the coverage table.
 */

import { handleMeta } from "./_meta.js";

/** Written by specular-edge; this Worker only ever reads it. */
const KV_KEY = "specular:last-known-good:v1";

/**
 * The curated service list, fixed order, always six, regardless of
 * traffic or data volume. AUTHORITATIVE COPY: the frontend mirrors
 * this as CURATED_SERVICES in atlas-systems/static/js/sonify/
 * mapping.js, and the two must match (same vendored-constant
 * discipline as _meta.js).
 */
const SERVICES = [
  "ramone-memory",
  "atlas-corpus",
  "specular-telemetry",
  "atlas-api-index",
  "ramone-trigger",
  "specular-edge",
];

/** Status scores for the overall_health mean. Unknown is excluded
 *  rather than scored: no data is not the same as bad data. */
const STATUS_SCORE = { healthy: 1, degraded: 0.5, down: 0 };

const META = {
  name: "specular-sonify",
  description:
    "Estate health reshaped into the /sonify frame the sonification engine plays",
  version: "1.0.0",
  endpoints: [
    {
      method: "GET",
      path: "/sonify",
      description:
        "Current estate frame: overall health, active incidents, six curated services",
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

/** A service record with no measurements. The contract's null rule:
 *  present in the list, status set, every numeric field null. */
function nullService(name, status) {
  return {
    name,
    status,
    latency_ms: null,
    uptime_pct: null,
    error_rate: null,
    last_deploy_secs_ago: null,
  };
}

/**
 * The adapter: one snapshot in, six contract records out. Everything
 * this store can honestly say, and nothing it cannot:
 *
 *   specular-telemetry  online:true + fresh saved_at -> healthy
 *                       online:true + stale saved_at -> degraded
 *                         (the machine claims life but the write path
 *                          has wedged somewhere; either way, suspect)
 *                       online:false                 -> down
 *                         (the machine sleeping is normal estate life
 *                          and is reported plainly as down; the sound
 *                          design treats it as state, not emergency)
 *   specular-edge       snapshot present -> healthy: only specular-edge
 *                       writes this key, so a parseable snapshot proves
 *                       the writer path end to end. Freshness cannot
 *                       distinguish an edge outage from a long machine
 *                       sleep (conditional writes go quiet offline), so
 *                       presence is the only honest signal here.
 *   everything else     unknown, all nulls, until richer keys exist.
 *
 * No latency, uptime, error-rate or deploy history exists in this
 * store for ANY service, so those fields are null across the board;
 * the frontend's per-status null defaults own what that sounds like.
 */
function deriveServices(snapshot, nowMs, staleAfterSecs) {
  return SERVICES.map((name) => {
    if (name === "specular-telemetry") {
      if (!snapshot) return nullService(name, "unknown");
      if (snapshot.online === false) return nullService(name, "down");
      const savedAtMs = Date.parse(snapshot.saved_at ?? "");
      const fresh =
        Number.isFinite(savedAtMs) &&
        nowMs - savedAtMs <= staleAfterSecs * 1000;
      return nullService(name, fresh ? "healthy" : "degraded");
    }
    if (name === "specular-edge") {
      return nullService(name, snapshot ? "healthy" : "unknown");
    }
    return nullService(name, "unknown");
  });
}

/**
 * Estate rollup. overall_health is the mean status score over services
 * with data; an all-unknown estate reads as 1.0 (the frontend renders
 * that as "healthy but silent": calm floor, no voices, no alarm from
 * absence alone). active_incidents counts services that are down.
 */
function deriveEstate(services) {
  const known = services.filter((s) => s.status !== "unknown");
  const health = known.length
    ? known.reduce((sum, s) => sum + STATUS_SCORE[s.status], 0) / known.length
    : 1;
  return {
    overall_health: Math.round(health * 1000) / 1000,
    active_incidents: services.filter((s) => s.status === "down").length,
  };
}

async function serveSonify(request, env) {
  const nowMs = Date.now();
  const staleAfterSecs = Number(env.STALE_AFTER_SECONDS || "1200");
  const snapshot = await readSnapshot(env);
  const services = deriveServices(snapshot, nowMs, staleAfterSecs);
  const payload = {
    timestamp: new Date(nowMs).toISOString(),
    estate: deriveEstate(services),
    services,
  };
  // no-store: the payload is ~600 bytes, the poll cadence is ten
  // seconds, and the whole point is liveness. Nothing here is worth a
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
