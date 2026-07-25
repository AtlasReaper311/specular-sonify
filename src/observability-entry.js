import worker, {
  deriveEstate,
  deriveServices,
} from "./index.js";

const DORA_NAME = "atlas-dora";
const KV_KEY = "specular:last-known-good:v1";
const DEFAULT_PUBLIC_API_BASE = "https://api.atlas-systems.uk/v1";
const VALID_STATUSES = new Set(["healthy", "degraded", "down", "unknown"]);

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

function json(body, request, env) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

function statusFrom(detail, componentValue) {
  if (VALID_STATUSES.has(detail?.status)) return detail.status;
  if (componentValue === true) return "healthy";
  if (componentValue === false) return "down";
  return "unknown";
}

export function doraServiceFromStats(stats) {
  const detail = stats?.estate?.component_details?.atlas_dora;
  const componentValue = stats?.estate?.components?.atlas_dora;
  const status = statusFrom(detail, componentValue);

  return {
    name: DORA_NAME,
    status,
    health_detail: detail?.detail ?? (status === "unknown" ? "DORA health evidence unavailable" : null),
    evidence_source: detail?.evidence_source ?? null,
    measured_at: detail?.measured_at ?? stats?.generated_at ?? null,
    latency_ms: Number.isFinite(detail?.latency_ms) ? detail.latency_ms : null,
    uptime_pct: Number.isFinite(stats?.uptime?.components?.atlas_dora)
      ? stats.uptime.components.atlas_dora
      : null,
    error_rate: null,
    last_deploy_secs_ago: null,
  };
}

function score(status) {
  if (status === "healthy") return 1;
  if (status === "degraded") return 0.5;
  if (status === "down") return 0;
  return null;
}

export function addDoraToFrame(payload, service) {
  if (!payload || typeof payload !== "object") return payload;
  const services = Array.isArray(payload.services) ? [...payload.services] : [];
  const existingIndex = services.findIndex((entry) => entry?.name === DORA_NAME);

  if (existingIndex >= 0) {
    services[existingIndex] = service;
  } else {
    const selfIndex = services.findIndex((entry) => entry?.name === "specular-sonify");
    const insertionIndex = selfIndex >= 0 ? selfIndex : services.length;
    services.splice(insertionIndex, 0, service);
  }

  const knownScores = services
    .map((entry) => score(entry?.status))
    .filter((value) => value !== null);

  payload.services = services;
  payload.estate = {
    ...(payload.estate ?? {}),
    overall_health: knownScores.length
      ? Math.round((knownScores.reduce((sum, value) => sum + value, 0) / knownScores.length) * 1000) / 1000
      : null,
    active_incidents: services.filter((entry) => entry?.status === "down").length,
  };
  return payload;
}

export function augmentMetaPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.endpoints)) {
    return payload;
  }
  return {
    ...payload,
    endpoints: payload.endpoints.map((endpoint) => endpoint?.path === "/sonify"
      ? {
          ...endpoint,
          description: "Current estate frame: overall health, active incidents, twenty-two evidence-backed services",
        }
      : endpoint),
  };
}

async function readSnapshot(env) {
  try {
    return await env.TELEMETRY_KV.get(KV_KEY, "json");
  } catch (error) {
    console.log("sonify composition: snapshot unreadable:", error.message);
    return null;
  }
}

async function fetchJson(fetchImpl, url) {
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers: { "user-agent": "specular-sonify/2.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { ok: false, latency_ms: Date.now() - started, body: null };
    }
    return {
      ok: true,
      latency_ms: Date.now() - started,
      body: await response.json(),
    };
  } catch (error) {
    console.log("sonify composition: upstream unreadable:", url, error.message);
    return { ok: false, latency_ms: null, body: null };
  }
}

async function readPublicFacts(env) {
  const hasBinding = env.ATLAS_PUBLIC && typeof env.ATLAS_PUBLIC.fetch === "function";
  const fetchImpl = hasBinding
    ? env.ATLAS_PUBLIC.fetch.bind(env.ATLAS_PUBLIC)
    : globalThis.fetch.bind(globalThis);
  const base = hasBinding
    ? "https://atlas-api-public/v1"
    : (env.PUBLIC_API_BASE || DEFAULT_PUBLIC_API_BASE).replace(/\/$/, "");
  const [stats, infra] = await Promise.all([
    fetchJson(fetchImpl, `${base}/stats`),
    fetchJson(fetchImpl, `${base}/infra/status`),
  ]);
  return {
    stats: stats.ok ? stats.body : null,
    infra: infra.ok ? infra.body : null,
    apiLatencyMs: stats.latency_ms,
  };
}

async function handleSonify(request, env) {
  const nowMs = Date.now();
  const timestamp = new Date(nowMs).toISOString();
  const staleAfterSecs = Number(env.STALE_AFTER_SECONDS || "1200");
  const [snapshot, facts] = await Promise.all([
    readSnapshot(env),
    readPublicFacts(env),
  ]);
  const services = deriveServices(snapshot, nowMs, staleAfterSecs, {
    ...facts,
    selfMeasuredAt: timestamp,
  });
  const payload = {
    timestamp,
    estate: deriveEstate(services),
    services,
  };
  addDoraToFrame(payload, doraServiceFromStats(facts.stats));
  return json(payload, request, env);
}

async function handleMeta(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) return response;
  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(augmentMetaPayload(payload)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/sonify" || url.pathname === "/sonify/")) {
      return handleSonify(request, env);
    }
    if (request.method === "GET" && url.pathname === "/sonify/_meta") {
      return handleMeta(request, env, ctx);
    }
    return worker.fetch(request, env, ctx);
  },
};
