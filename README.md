<div align="center">
  <img src="https://raw.githubusercontent.com/AtlasReaper311/AtlasReaper311/main/atlas-icon-dark-256.png" width="88" alt="Atlas Systems"/>
</div>

# specular-sonify

```
┌─────────────────────────────────────────────┐
│  ATLAS SYSTEMS // specular-sonify           │
│  read-only estate telemetry for sound       │
└─────────────────────────────────────────────┘
```

![Runtime](https://img.shields.io/badge/runtime-cloudflare_workers-f5a623?style=flat-square&labelColor=0a0a0f)
![Status](https://img.shields.io/badge/status-ready_to_deploy-4ade80?style=flat-square&labelColor=0a0a0f)
![Store](https://img.shields.io/badge/store-telemetry_kv-aaa9a0?style=flat-square&labelColor=0a0a0f)
![Cost](https://img.shields.io/badge/cost-%C2%A30-aaa9a0?style=flat-square&labelColor=0a0a0f)

`specular-sonify` is a Cloudflare Worker that turns current Atlas telemetry into the fixed `/sonify` frame used by the site audio module. It is deliberately read-only: it reads the `TELEMETRY_KV` snapshot maintained by `specular-edge`, reads public facts from `atlas-api-public`, derives only what those sources can honestly prove, and performs zero KV writes.

## Prerequisites

- Node.js 18 or newer
- `npx wrangler` authenticated against the Atlas Systems Cloudflare account
- Access to the existing `TELEMETRY_KV` namespace
- The `api.atlas-systems.uk/sonify*` Worker route available in Cloudflare

## Setup

```bash
git clone https://github.com/AtlasReaper311/specular-sonify.git
cd specular-sonify
npx wrangler whoami
```

There are no secrets to set. The Worker reads public estate telemetry and has no token-bearing write path.

## Usage

```bash
npx wrangler deploy
curl -sS https://api.atlas-systems.uk/sonify
curl -sS https://api.atlas-systems.uk/sonify/_meta
```

`GET /sonify` returns one current estate frame with `overall_health`, `active_incidents`, and the exact twenty-one evidence-backed service records rendered by System SYMPHONY. `GET /sonify/_meta` returns the estate-standard self-description supplied by the vendored `_meta.js` helper.

## Contract

```json
{
  "timestamp": "2026-07-07T12:00:00.000Z",
  "estate": {
    "overall_health": 0.75,
    "active_incidents": 0
  },
  "services": [
    {
      "name": "ramone-memory",
      "status": "unknown",
      "health_detail": null,
      "evidence_source": null,
      "measured_at": null,
      "latency_ms": null,
      "uptime_pct": null,
      "error_rate": null,
      "last_deploy_secs_ago": null
    }
  ]
}
```

The `services` array always contains the same twenty-one entries in the same order: `ramone-memory`, `atlas-corpus`, `specular-telemetry`, `atlas-api-public`, `atlas-api-index`, `atlas-notify`, `ramone-trigger`, `specular-edge`, `github-pulse`, `site-pulse`, `deploy-watch`, `atlas-badges`, `atlas-blackbox`, `atlas-dep-audit`, `atlas-doc-viewer`, `atlas-journey-watch`, `atlas-quota-watch`, `atlas-systems`, `ramone-edge`, `specular-sonify`, and `status`. A service whose current evidence cannot determine health is still present with status `unknown` and null numeric fields; null is part of the contract, not an error case.

`health_detail`, `evidence_source`, and `measured_at` are additive transparency fields. They show the bounded explanation, the current public fact that produced the status, and when that fact was observed. They do not contain credentials, workflow logs, actors, or private data.

| Service | Current evidence |
| --- | --- |
| `ramone-memory` | Fresh `/v1/infra/status` Ollama check, otherwise current `/v1/stats` machine probe |
| `atlas-corpus` | Fresh `/v1/infra/status` corpus checks, otherwise current `/v1/stats` corpus probe |
| `specular-telemetry` | `TELEMETRY_KV` snapshot with `/v1/stats` fallback |
| `atlas-api-public` | Successful `/v1/stats` request and its request latency |
| `atlas-api-index` | `/v1/stats` registry probe |
| `atlas-notify` | `/v1/stats` notify probe |
| `ramone-trigger` | Dedicated `/v1/stats` `ramone_trigger` probe |
| `specular-edge` | Dedicated `/v1/stats` `specular_edge` reachability probe |
| `github-pulse` | `/v1/stats` `github_pulse` probe |
| `site-pulse` | `/v1/stats` `site_pulse` probe |
| `deploy-watch` | `/v1/stats` `deploy_watch` probe |
| `atlas-badges` | Current-main CI evidence supplied by `github-pulse` through `/v1/stats` |
| `atlas-blackbox` | `/v1/stats` flight-recorder health probe |
| `atlas-dep-audit` | Fresh weekly scheduled-run evidence supplied by `github-pulse` |
| `atlas-doc-viewer` | `/v1/stats` public site reachability probe |
| `atlas-journey-watch` | Fresh six-hour scheduled-run evidence supplied by `github-pulse` |
| `atlas-quota-watch` | `/v1/stats` quota contract and threshold verdict |
| `atlas-systems` | `/v1/stats` primary site reachability probe |
| `ramone-edge` | `/v1/stats` public edge status probe; sleeping local AI remains a separate fact |
| `specular-sonify` | Current request handler execution |
| `status` | `/v1/stats` public status-surface reachability probe |

## Operational Notes

`TELEMETRY_KV` currently holds one key: `specular:last-known-good:v1`, which can provide the most specific classification for `specular-telemetry`. `atlas-api-public` contributes nineteen current estate component verdicts plus the success and latency of the current stats request as its own twentieth service fact. The executing `specular-sonify` handler supplies only its own twenty-first verdict. A stale sentinel or estate snapshot is never reused as current health. Registry metadata is descriptive only and is never treated as health. Fields with no source remain null: error rate and deploy age are not guessed.

`overall_health` is the mean score over known services only: `healthy` is `1`, `degraded` is `0.5`, and `down` is `0`. Unknown services are excluded because no data is not the same as bad data; if every service is unknown, health is `null` rather than an invented `1.0`. `/sonify` is served with `cache-control: no-store`; the payload is small and the point of the endpoint is liveness.

## Validation

```bash
npm test
node --check src/_meta.js
node --check src/index.js
```

## How it fits into Atlas Systems

`specular-sonify` sits between [`specular-telemetry`](https://github.com/AtlasReaper311/specular-telemetry), which maintains the source snapshot, and [`atlas-systems`](https://github.com/AtlasReaper311/atlas-systems), which turns the frame into the browser sonification widget. It follows the same public API discipline as [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index): small route surface, explicit `_meta`, and no hidden mutation.

The transferable pattern is a narrow adapter that protects a public contract from an incomplete backing store by saying only what it can prove.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
