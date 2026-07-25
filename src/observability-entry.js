import worker from "./index.js";

const DORA_NAME = "atlas-dora";
const VALID_STATUSES = new Set(["healthy", "degraded", "down", "unknown"]);

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

async function fetchStats(env) {
  const hasBinding = env.ATLAS_PUBLIC && typeof env.ATLAS_PUBLIC.fetch === "function";
  const fetcher = hasBinding ? env.ATLAS_PUBLIC : globalThis;
  const base = hasBinding
    ? "https://atlas-api-public/v1"
    : (env.PUBLIC_API_BASE || "https://api.atlas-systems.uk/v1").replace(/\/$/, "");

  const response = await fetcher.fetch(`${base}/stats`, {
    headers: { "user-agent": "specular-sonify/2.0" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`stats answered ${response.status}`);
  return response.json();
}

async function handleSonify(request, env, ctx) {
  const response = await worker.fetch(request, env, ctx);
  if (!response.ok) return response;

  let payload;
  try {
    payload = await response.clone().json();
  } catch {
    return response;
  }

  if (Array.isArray(payload?.services) && payload.services.some((entry) => entry?.name === DORA_NAME)) {
    return response;
  }

  let service;
  try {
    service = doraServiceFromStats(await fetchStats(env));
  } catch (error) {
    service = {
      name: DORA_NAME,
      status: "unknown",
      health_detail: String(error?.message ?? error).slice(0, 120),
      evidence_source: "atlas-api-public:/v1/stats#estate.component_details.atlas_dora",
      measured_at: null,
      latency_ms: null,
      uptime_pct: null,
      error_rate: null,
      last_deploy_secs_ago: null,
    };
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(addDoraToFrame(payload, service)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/sonify" || url.pathname === "/sonify/")) {
      return handleSonify(request, env, ctx);
    }
    return worker.fetch(request, env, ctx);
  },
};
