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

`specular-sonify` is a Cloudflare Worker that turns the current Atlas telemetry snapshot into the fixed `/sonify` frame used by the site audio module. It is deliberately read-only: it reads the `TELEMETRY_KV` snapshot maintained by `specular-edge`, derives only what that store can honestly prove, and performs zero KV writes.

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

`GET /sonify` returns one current estate frame with `overall_health`, `active_incidents`, and six fixed service records. `GET /sonify/_meta` returns the estate-standard self-description supplied by the vendored `_meta.js` helper.

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
      "latency_ms": null,
      "uptime_pct": null,
      "error_rate": null,
      "last_deploy_secs_ago": null
    }
  ]
}
```

The `services` array always contains the same six entries in the same order: `ramone-memory`, `atlas-corpus`, `specular-telemetry`, `atlas-api-index`, `ramone-trigger`, and `specular-edge`. A service the store knows nothing about is still present with status `unknown` and null numeric fields; null is part of the contract, not an error case.

## Operational Notes

`TELEMETRY_KV` currently holds one key: `specular:last-known-good:v1`. That means `specular-sonify` can classify `specular-telemetry` from the hardware snapshot and `specular-edge` from the presence of a parseable snapshot, while the other curated services remain `unknown` until richer keys exist.

`overall_health` is the mean score over known services only: `healthy` is `1`, `degraded` is `0.5`, and `down` is `0`. Unknown services are excluded because no data is not the same as bad data. `/sonify` is served with `cache-control: no-store`; the payload is small, the poll cadence is ten seconds, and the point of the endpoint is liveness.

## How it fits into Atlas Systems

`specular-sonify` sits between [`specular-telemetry`](https://github.com/AtlasReaper311/specular-telemetry), which maintains the source snapshot, and [`atlas-systems`](https://github.com/AtlasReaper311/atlas-systems), which turns the frame into the browser sonification widget. It follows the same public API discipline as [`atlas-api-index`](https://github.com/AtlasReaper311/atlas-api-index): small route surface, explicit `_meta`, and no hidden mutation.

The transferable pattern is a narrow adapter that protects a public contract from an incomplete backing store by saying only what it can prove.

---

Part of [atlas-systems.uk](https://atlas-systems.uk)
