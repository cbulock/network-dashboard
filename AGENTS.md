# agents.md — Network Dashboard

This repo is a **Nuxt-based Network Dashboard**. The goal is to present a unified view of **devices + service health** by pulling from upstream systems, normalizing, and serving it through the app.

Repo tree (current):

* `.nuxt/`, `.output/` (build artifacts)
* `.vscode/settings.json`
* `logs/unifi.log`
* `pages/index.vue`
* `public/*`
* `scripts/`

  * `fetch-ha.js`
  * `fetch-unifi.js`
  * `fetch-uptime-kuma.js`
  * `uk2.js` (experimental/alt script)
* `server/api/devices.js`
* `nuxt.config.ts`, `tsconfig.json` (Nuxt/TS config exists even if most code is JS)

---

## Project goal

A single dashboard that answers:

* **What devices do I have?** (name, IP(s), MAC, source)
* **Are they online?** (last seen / health)
* **What services are failing?** (Nagios / Uptime Kuma style monitors)

Primary sources (intended):

* UniFi Controller / UDM-Pro
* Home Assistant
* Uptime Kuma (Prometheus `/metrics` endpoint)

Design intent (current approach):

* Upstream fetching lives in **scripts**.
* UI/API renders from **normalized data** (ideally persisted in Postgres as this matures).

---

## Current running parts

### UI

* **Nuxt pages router** is being used (`pages/index.vue`).

### Server API

* `server/api/devices.js` exists and is the main API surface right now.

  * Keep this endpoint stable; it’s the contract the UI will lean on.

### Collectors (scripts)

These scripts fetch upstream data:

* `scripts/fetch-unifi.js` — UniFi fetcher
* `scripts/fetch-ha.js` — Home Assistant fetcher
* `scripts/fetch-uptime-kuma.js` — Uptime Kuma metrics fetcher
* `scripts/uk2.js` — alternate experiment; treat as non-canonical unless promoted

Logging:

* `logs/unifi.log` exists (UniFi debug/trace output). Don’t commit secrets into logs.

---

## Conventions and constraints

* Prefer **modern JavaScript** for new code (repo has TS config, but don’t require TS).
* Keep integrations isolated in `scripts/` (collector-like) unless there’s a clear reason to move server-side.
* Avoid putting long-lived credentials in code. Use `.env`.
* Don’t treat `.nuxt/` and `.output/` as source-of-truth (generated).

---

## Environment variables

`.env` exists in the repo root.

Expected (based on current integrations):

### UniFi

* `UNIFI_URL=...`
* `UNIFI_USERNAME=...`
* `UNIFI_PASSWORD=...`
* `UNIFI_SITE=...` (often `default`)
* Optional: allow insecure TLS for self-signed controllers

### Home Assistant

* `HA_URL=http://<host>:8123`
* `HA_TOKEN=...`

### Uptime Kuma (Prometheus metrics)

* `KUMA_METRICS_URL=http://<host>:<port>/metrics`
* `KUMA_API_KEY=...`

Auth nuance to preserve:

* Basic Auth for `/metrics` uses **blank username** and **API key as password**.

---

## How data should flow (target model)

Right now, the repo has fetch scripts + a single API endpoint. The intended direction:

1. **Fetch** from upstream systems (scripts)
2. **Normalize** into a shared shape (single module later, if needed)
3. **Persist** to Postgres (planned next stage)
4. **Serve** via `server/api/*`
5. **Render** via `pages/*`

This keeps the UI fast, reduces dependency on live upstream latency, and centralizes auth complexity.

---

## In-flight work threads (what agents should preserve)

1. **Make the device list real**

   * Ensure `server/api/devices.js` returns a stable, useful shape:

     * `id`, `name`, `ip`, `mac`, `source`, `status`, `lastSeen`
     * allow multiple IPs when known

2. **UniFi ingestion**

   * Continue improving `scripts/fetch-unifi.js`.
   * Prefer `unifi-client` package for UniFi access.
   * Capture enough metadata to map clients/devices reliably (MAC is king).

3. **Home Assistant ingestion**

   * `scripts/fetch-ha.js` should summarize availability / device/entity mapping.
   * Avoid dumping every entity into the UI; normalize.

4. **Uptime Kuma ingestion**

   * `scripts/fetch-uptime-kuma.js` should scrape `/metrics`, parse, and aggregate.
   * Group/aggregate by hostname (or monitor label), then upsert/emit normalized status.

5. **Move toward persistence (Postgres)**

   * This repo doesn’t show DB migrations yet; when added, prefer:

     * deterministic IDs
     * upserts
     * provenance fields (`source`, `source_id`)

---

## “Don’t break this” rules

* Don’t commit `.env` contents.
* Don’t build app logic on `.nuxt/` or `.output/`.
* Don’t spread normalization across UI + server + scripts; pick one place as it evolves (likely `scripts/` → DB → `server/api`).
* Keep experimental scripts clearly marked (like `uk2.js`).

---

## Practical VS Code notes

* `.vscode/settings.json` exists; keep it minimal and repo-safe.
* When adding tasks:

  * Prefer `npm run ...` scripts (see `package.json`) for repeatability.

---

## Next steps (most likely)

* Expand `server/api/*` beyond `devices.js` (monitors/services next)
* Decide where normalized state lives *today*:

  * quick win: JSON cache written by scripts and read by API
  * durable win: Postgres tables + upserts
* Add filtering/sorting in `pages/index.vue` (status, source, last seen)