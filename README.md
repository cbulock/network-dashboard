# Network Dashboard

Nuxt-based network inventory app that pulls device and health data from UniFi, Home Assistant, and Uptime Kuma, then serves a normalized view through the app.

## Current frontend shape

- **Interface:** Responsive workspace shell with a dark navigation rail, green accents, and locally bundled Mona Sans / JetBrains Mono fonts. Creation and network forms use Cindor UI via `cindor-ui-vue`; device details use Cindor selects and native text controls with the same theme tokens.
- **Inventory dashboard:** `/`
- **Device cleanup:** `/cleanup`
- **Device create:** `/devices/new`
- **Device detail/edit:** `/devices/:id`
- **Network management:** `/network`
- **Reserved ranges overview:** `/reserved-ranges` groups all inventory records by their normalized reserved-range membership, including History. Each range shows its boundaries, VLAN, device/IP counts, and one row per device with Label, Hostname, IP, and MAC. Only addresses belonging to that range appear; multiple matching addresses stay on one row. Rows sort by IP, empty ranges remain visible, and each row has a Details action to open the full device page; labels also link there. Refresh reads stored inventory and lookups.

Use **Appearance** in the navigation to choose System, Light, or Dark. The choice is saved in this browser; System follows your operating system and updates when its color preference changes.

The inventory puts search and **Networks, Device types, Roles, Monitoring health** above the device list. Search matches names, hostnames, DNS aliases, primary/secondary IPs and MACs (including colon-free or hyphenated MAC input). Selections within each filter match any selected value; different filters combine. Tags, IP presence and DNS mismatch are under **More filters**. Individual filter chips are removable; **Clear filters** keeps the Current/History scope. Filters and sorting persist in this browser, including migration of the previous network/status/IP filters. Pagination offers 25, 50 or 100 devices.

Counts and pagination use the same complete filtered set. Monitoring health is consistently **Healthy**, **Failing**, **Not monitored**, or **Unknown**. The existing API `status` contract remains unchanged; the additive `monitoring` field marks results older than 24 hours as stale/Unknown. Connectivity never overrides monitoring health. Refresh reloads stored records and network lookups without running collectors.

**Current** is the default. Unconfigured, unmonitored devices last seen more than 90 days ago appear in **History**; exactly 90 days remains Current. Unknown observation dates stay Current. Controller observation timestamps take precedence over collector ingestion times. Manual devices, adopted network equipment, active DNS records, managed hostnames, and devices explicitly marked **Keep in Current** count as configured. Remembered fixed/static IP settings alone do not keep a device Current; old DHCP reservations can outlive a device. Monitoring links keep devices Current even when failing or stale. Details show the specific retention reason. History is calculated on reads, never by deleting or moving source records.

Click a row to expand addresses with copy actions, MAC, available hardware/connection information, health-check freshness, DNS state, notes and tags. The chevron is keyboard accessible. **Details** opens the full device page directly; **Back to results** preserves the current filters, page, expansion and scroll position. Identical name/hostname text is shown once, and internal discovery IDs are kept in diagnostics. Mobile rows reflow instead of requiring horizontal scrolling.

Device type and role suggestions use explicit hardware metadata, never name guesses. Network equipment suggests Infrastructure; cameras and explicit smart-home types suggest IoT. Unsupported metadata remains Unknown/Unassigned. **Organization** lets users correct both independently or return to automatic suggestions, and opt to keep a device Current. Nullable `devices.device_type` and `devices.device_role` store overrides; `devices.keep_current` stores the explicit retention choice. Collector upserts preserve these fields. API responses add `classification`, `deviceType`, `role`, `lifecycle`, `hardware`, `connection`, and `monitoring` without changing identity matching or network/IP ownership.

Device cleanup lists devices with at least one reported IP outside every configured reserved range, including secondary IPv4 and IPv6 addresses. Range boundaries are inclusive; VLAN membership and legacy range labels without IP boundaries do not count as reservations. Devices without IPs are excluded. With no bounded ranges configured, every device with an IP appears. Cleanup defaults to All records and has its own saved filters; clearing filters keeps the cleanup rule active. Open Details or manage reserved ranges, then refresh to recalculate the list.

The layout adapts to mobile navigation and stacked rows. Keyboard focus, a skip link, labeled filters, loading/error/empty states, and reduced-motion preferences are supported.

### Device details

`/devices/:id` opens a read-first workspace. The header uses the optional friendly label, then hostname, then the existing device name. Monitored health is **Healthy**, **Failing**, **Unknown**, or **Not monitored** when no monitoring record is linked; network connectivity does not override health.

**Network & DNS** groups the primary address, assignment mode, hostname, inferred network, and reserved range. Additional addresses expand with their network context. **Change address** and **Edit hostname** are separate actions; each has its own apply/cancel controls. Technical details contain MAC correction, connection state, DNS aliases, and explicitly labeled timestamps. Sources and record identifiers are collapsed at the bottom.

Name, hostname, MAC, and organization edits have independent drafts and save only changed fields. Refreshes and operation polling retain unsaved edits; leaving with changes requires confirmation. Pending IP/DNS work blocks competing network edits while name, tags, and notes remain editable. The page shows confirmed values until the operation completes, with a single progress area that distinguishes an applied IP with failed DNS from a failed address change. Refresh on this page reads fresh network and DNS evidence; inventory Refresh continues to read cached records.

Presentation and section-payload tests live in `tests/device-presentation.test.js`. Inventory lifecycle, filtering and classification tests live in `tests/inventory-ux.test.js`. `RUN_DB_TESTS=1 node --test tests/inventory-ux.integration.test.js` verifies classification persistence and collector preservation in connection-local temporary tables with `search_path=pg_temp`; existing records are not changed. Other database integration tests remain opt-in.

## Current backend shape

- **Legacy device view:** `GET /api/devices`
- **Legacy source remapping:** `POST /api/devices`
- **Inventory list:** `GET /api/inventory/devices`
- **Inventory create:** `POST /api/inventory/devices`
- **Inventory detail:** `GET /api/inventory/devices/:id`
- **Inventory update:** `PATCH /api/inventory/devices/:id`
- **Inventory lookups:** `GET /api/inventory/lookups`
- **VLAN upsert:** `POST /api/inventory/vlans`
- **Reserved range upsert:** `POST /api/inventory/reserved-ranges`

## Data model direction

The app now keeps a distinction between:

- **Discovered device data** from upstream collectors
- **Inventory-managed data** used by the app UI

Core tables include:

- `devices`
- `device_sources`
- `device_tags`
- `device_tag_assignments`
- `vlans`
- `virtual_subnets` (reserved ranges)
- `device_ip_assignments`
- `subnet_allocations`
- source snapshot tables for UniFi, Home Assistant, and Uptime Kuma

`devices.ips` is an idempotent projection of UniFi observations. Only UniFi establishes current device IP ownership. Legacy `device_ip_assignments` records remain for recovery and provenance but no longer supply addresses to inventory, matching, DNS targets, network counts, or cleanup.

Automatic network identity matching never uses friendly names. Exact MACs take priority; otherwise source IPs must identify one device through UniFi-reported ownership, with no conflicting MAC. Shared or ambiguous IPs stay separate. Stable non-HA source IDs retain existing mappings, and conflicting MAC changes require review. Explicit source remaps are marked `manual` and survive subsequent imports.

Uptime Kuma matches monitor hostnames to a unique inventory hostname, active DNS alias, or UniFi hostname, including previously imported standalone monitor records. Bare IPv4 and IPv6 targets in Kuma's `monitor_hostname` field instead use unique UniFi-reported IP ownership; these targets are also recorded in the source identity. Matching ignores hostname case and a trailing DNS dot; it does not guess suffixes, parse URLs as device identities, resolve DNS, or use display names. Ambiguous or unmatched targets retain their existing mapping. Manual mappings take priority. Home Assistant keeps its MAC/IP-only policy.

Preview existing Kuma associations with `node scripts/repair-kuma-links.js --source-id cameron-desk.switch` or `--source-id 10.0.0.50`; add `--apply` to repair that target. Omit `--source-id` to audit all targets. Apply runs transactionally, saves original device/source rows in a recovery manifest under `.data/repairs/kuma-links-*.json`, and removes only empty monitor-only duplicates without curated fields, tags, addresses, allocations, merge aliases, or network/DNS jobs. Physical devices and curated duplicate rows are retained. Duplicate removal uses the device merge history and old-ID redirects; it preserves monitor readings and snapshots while keeping the link automatic. Colliding device-keyed aggregate snapshots are archived in merge history, with the newest aggregate retained. Rerun the preview after applying; it should report zero changes. Kuma snapshots support both legacy hostname-keyed tables and current device-keyed tables.

Home Assistant states are entities, not physical devices. The collector retains every entity snapshot but links a new entity automatically only when its own MAC/IP identifies an inventory device. Entities without sufficient evidence remain in `device_sources` with a null `device_id`; they do not create new inventory devices. Existing manually linked entities and standalone legacy entity records remain linked. AP/gateway MACs and shared friendly names do not establish ownership. The editor groups linked records by system, explains each system's role, and puts entity/device/monitor IDs in expandable details.

Audit existing Home Assistant associations with `node scripts/repair-ha-links.js` (read-only by default). Apply the same identity policy with `node scripts/repair-ha-links.js --apply`. The repair runs in a transaction, preserves manual links, and saves previous mapping IDs in an ignored `.data/repairs/ha-links-*.json` recovery manifest before changing anything. It preserves entity snapshots, timestamps, device records, and manual inventory fields. Unsupported links are detached rather than guessed; existing entity-only inventory rows are retained for review. No upstream collector is run by this command. Schema setup supports legacy `details` snapshots and `mapped_device_key` overrides alongside the current `raw_data` and `link_method` fields.

Device health is stored on `device_sources.status` for Uptime Kuma mappings. Inventory create/update requests ignore supplied `status` values, and other collectors cannot set device health. Reads ignore the legacy `devices.status` column, which may contain manual values or unrelated integration states. With multiple Kuma mappings, any Down reading makes the device Down; all readings must be Up to show Up. Otherwise it shows Unknown. Source remapping moves the health reading with its source mapping.

Schema setup adds the nullable source status column to existing databases. After upgrading, run `node scripts/fetch-uptime-kuma.js` to populate trusted readings; existing devices show Unknown until this sync. The collector uses the registry's connected DB client and writes snapshots using the `uptime_kuma_data` schema defined by the registry.

After source remapping, preview empty imported remnants with `node scripts/cleanup-orphan-devices.js`; add `--apply` to remove eligible rows. Cleanup preserves manual devices, MAC/IP identity, local settings and notes, retained snapshots, source mappings, merge history, and all database foreign-key references. Apply rechecks under table locks and saves the full removed device rows in `.data/repairs/orphan-devices-*.json` before deletion. Rerun the preview to verify zero eligible rows remain. Source-free devices with configuration are retained for review.

VLAN membership is derived automatically from IP addresses and the CIDR ranges configured on `/network`. Both discovered and manual addresses participate; the longest matching prefix wins for each address (ties use the lowest VLAN number). IPv4 and IPv6 are supported. Addresses without a matching range remain unmatched.

Inventory responses include `vlans` for every matching network and retain `vlan` for the primary IP's matching network. VLAN filters and usage counts include all matching networks. Membership is recalculated on reads, so changing a network range takes effect on the next refresh without editing devices or rerunning collectors. Device create/update requests ignore legacy `vlanId` fields, and old stored VLAN assignments are no longer used.

Reserved ranges accept a name and inclusive `startIp` / `endIp` addresses on `/network` and `POST /api/inventory/reserved-ranges` (the legacy `/virtual-subnets` route remains an alias). Both IPs must be valid, use the same address family, and be in ascending order; a single-address range is allowed. VLAN selection is automatic: the most specific configured subnet containing the entire range wins. Requests ignore supplied `vlanId` values. A range with no matching subnet can still be saved and used without a VLAN.

IP boundaries are persisted on `virtual_subnets`; schema setup adds the two nullable columns to existing databases without changing existing records. Lookups recalculate the range's VLAN on refresh. All known device IPs (primary, discovered, DNS, and manual) match inclusive reserved boundaries, with narrower overlapping ranges preferred and equal ranges resolved by database ID. Inventory responses include `reservedRanges` with each matched range's `id`, `name`, and deduplicated `ips`; usage counts and device labels use these matches. Membership is recalculated on reads, so existing devices appear immediately after creating a range or changing its boundaries without rerunning collectors. Legacy range records without boundaries retain their existing explicit assignment grouping; resave the same slug with start and end IPs to define their boundaries.

## Setup

### Docker deployment

The image runs the production Nuxt server on port 3000 as the unprivileged
`node` user. It also includes the standalone collectors and OpenSSH client.
The [multi-stage build](https://docs.docker.com/build/building/multi-stage/)
installs from `package-lock.json`; local dependencies, generated output, `.env`
files, logs and private keys are excluded from the build context.

On a new deployment host:

```sh
cp docker.env.example .env
# Edit .env with the database and upstream connection details.
docker compose config --quiet
docker compose up -d --no-build --pull always dashboard
docker compose ps
docker compose logs --tail=100 dashboard
```

Open `http://<docker-host>:3000` (or the `DASHBOARD_PORT` configured in `.env`).
`GET /api/health` is the container's HTTP liveness check; it does not check
PostgreSQL or upstream systems. Verify `/api/inventory/devices` as well to confirm
database connectivity. Keep access on your trusted network or place an
authenticated reverse proxy in front of it; the app has no login screen.

**Database:** PostgreSQL is external to this Compose stack. Set `DATABASE_URL`
to an existing database reachable from the container, with permissions to create
and alter its tables. Schema setup runs automatically on the first inventory
request or collector run. A new empty database starts with an empty inventory.
To retain existing inventory, point to the same database or back it up and restore
it on the destination before switching hosts. `localhost` in a container refers
to that container; for a database on the Docker Desktop host, use
`host.docker.internal`. On Linux use a reachable host address or configure the
equivalent host-gateway mapping. Verify that Docker can resolve and reach the
database, UniFi, Home Assistant, Kuma and optional DNS controller hostnames.

**Collection:** inventory Refresh reads stored data. Run collectors explicitly,
or schedule these commands with the deployment host's scheduler at your desired
interval (avoid overlapping runs of the same collector):

```sh
docker compose exec -T dashboard node /app/scripts/fetch-unifi.js
docker compose exec -T dashboard node /app/scripts/fetch-ha.js
docker compose exec -T dashboard node /app/scripts/fetch-uptime-kuma.js
```

The continuous worker handles queued UniFi IP changes and DNS operations. Enable
it when using those controls, even if you do not use DNS Platform:

```sh
docker compose --profile worker up -d --no-build --pull always
docker compose logs --tail=100 worker
```

Without DNS Platform configuration, the worker can still process UniFi jobs;
DNS import attempts log configuration errors. Only one worker may hold the
database advisory lock. Before moving operation processing to Docker, reconcile
pending operations and stop the old host's scheduled worker using the commands
in the DNS Platform section below.

**Optional DNS Platform SSH:** set `DNS_PLATFORM_SSH_TARGET`, set
`DNS_PLATFORM_SSH_KEY=/home/node/.ssh/id_ed25519`, and set `DASHBOARD_SSH_DIR`
to an absolute directory on the Docker host. Put only the dedicated restricted
controller key (`id_ed25519`) and a verified `known_hosts` file in that directory.
The image uses UID/GID 1000; on Linux make the directory/key owned by that user,
with directory mode 700 and key mode 600. The mount is read-only and SSH retains
strict host-key checking. Start both services with the SSH overlay:

```sh
docker compose -f compose.yaml -f compose.ssh.yaml --profile worker up -d --no-build --pull always
docker compose -f compose.yaml -f compose.ssh.yaml exec -T dashboard node /app/scripts/fetch-dns-platform.js
```

Use the same Compose file/profile flags for subsequent updates. Repeat the
`up -d --no-build --pull always` command to pull the published image and recreate
changed services. To build from a local checkout instead, use
`docker compose up -d --build dashboard` (include the worker/SSH flags as needed).
`.data` repair manifests persist in the `dashboard-data` named volume; all
inventory and queued jobs persist in PostgreSQL. Back up both. `docker compose
down` preserves the named volume; `down -v` deletes it. Never bake `.env` or SSH
keys into an image. To build/run without Compose:

```sh
docker build -t network-dashboard:local .
docker run -d --name network-dashboard --init --restart unless-stopped --env-file .env -p 3000:3000 -v network-dashboard-data:/app/.data network-dashboard:local
```

### Automated image publishing

[GitHub Actions](https://github.com/cbulock/network-dashboard/actions/workflows/container.yaml)
tests and builds pull requests without publishing. Pushes to `main` publish
`ghcr.io/cbulock/network-dashboard:latest` and a `sha-<full-commit>` tag. Tags
matching `v*` publish that version tag (for example, `v1.0.0`) and its commit tag;
they do not move `latest`. The workflow can also be run manually on `main`.

Images support `linux/amd64` and `linux/arm64`. Before publication, CI starts the
AMD64 image without database credentials and verifies HTTP health, dashboard
HTML, collector imports, SSH availability, non-root execution and writable
repair storage. Publishing follows GitHub's
[Container Registry workflow](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
using its automatic `GITHUB_TOKEN` with `packages: write`; no registry password
or integration credentials need to be added to Actions secrets.

The public image is hosted in
[GitHub Packages](https://github.com/users/cbulock/packages/container/package/network-dashboard).
No registry login is required:

```sh
docker pull ghcr.io/cbulock/network-dashboard:latest
```

The workflow preserves the package's configured visibility. For private forks,
sign in on the Docker host with a GitHub token that has `read:packages` using
`docker login ghcr.io`.

To pin a deployment or roll back, set `DASHBOARD_IMAGE` in `.env` to a published
version, `sha-<full-commit>` tag, or `ghcr.io/cbulock/network-dashboard@sha256:<digest>`
from the workflow summary, then repeat the Compose update command. Images are
hosted on GitHub; PostgreSQL and the running application stay on your Docker host.

### UniFi

Set `UNIFI_HOST`, `UNIFI_USER`, and `UNIFI_PASS` in `.env`; `UNIFI_SITE` defaults to `default`. Run `npm run unifi:fetch` to collect connected clients (`stat/sta`), known/offline clients and reservations (`rest/user`), network settings (`rest/networkconf`), and managed UniFi devices (`stat/device`), including switches, access points, and gateways. Existing scheduled calls to `node scripts/fetch-unifi.js` also collect both. Inventory Refresh reads the database and does not run this collector.

Both inventories use the existing `unifi` source and stable controller IDs (MAC fallback), matching existing devices by exact MAC or unique, non-conflicting IP, using UniFi address ownership. DNS record association is retained independently through the managed hostname. Managed-device type, model, firmware, adoption state, and observation time are retained without storing controller management secrets. Records without a valid device MAC are skipped and counted. Imports validate both responses before writing, then save snapshots and source links in one transaction. Device health continues to come exclusively from Uptime Kuma.

### DNS Platform

DNS Platform supplies hostnames and actual address/name records. Records attach to unique UniFi address owners or existing managed-hostname bindings. DNS-only records do not manufacture network devices or current IP ownership; ambiguous records remain unlinked. DNS is authoritative for hostnames, inventory labels stay local, and health remains exclusively from Uptime Kuma. Failed imports retain the previous snapshot and show a synchronization error.

Set `DNS_PLATFORM_SSH_TARGET` to the restricted controller account on Tools and `DNS_PLATFORM_SSH_KEY` to this dashboard host's private key. Pin the verified Tools host key in the account's SSH known-hosts file. Keep all settings server-side in `.env`. Install the controller using the DNS Platform repository's `docs/runbooks/dashboard-controller.md`; resolver and Git credentials stay on Tools or the resolver hosts.

Run `npm run dns:fetch` for a single import and `npm run dns:worker` continuously beside the dashboard. The worker imports every five minutes, polls active requests every two seconds, and refreshes records after terminal jobs. It reconnects after database interruptions and reacquires its advisory lock before resuming; only one worker may hold that lock. Configure your host's service manager to restart the worker on failure. Refresh in the inventory remains a cached database refresh, not an upstream fetch.

On Windows, `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-dns-worker.ps1` installs and starts the **Network Dashboard DNS Worker** logon task for the current user. It launches Node directly so stopping the task also stops the worker, restarts failures, and writes `.data/dns-worker.log`; no password is stored. Stop it with `Stop-ScheduledTask -TaskName 'Network Dashboard DNS Worker'`, or remove it with `Unregister-ScheduledTask` when moving the dashboard to another host. The task runs while that Windows user is logged in.

The editor selects a target IPv4 address and previews bare-name/`.bulock` expansion. Saving a hostname queues a durable request in the same transaction as inventory edits. Old names remain aliases. Blank names do not delete records; IPv6 publishing, alias deletion, and unrequested automatic name movement are not supported. Explicit address moves use the capability-checked `hostname.move` controller protocol described below. Existing shared names may remain, but new conflicting assignments fail. Unchanged names/targets and inventory-only edits do not trigger deployment.

Inventory responses retain their existing contract and add `dns` metadata: configured state, target IP, address/name records, revision, last synchronization/error, and the latest operation. Create/update accepts `dns: { targetIp, expectedRevision }` alongside `hostname`. `GET /api/inventory/dns` returns integration state; `GET /api/inventory/devices/:id/dns` supplies polling state; `POST /api/inventory/devices/:id/dns-retry` requests a failed deployment retry. Legacy callers changing `hostname` are routed through the same queue.

Pending, Deploying, Live and Failed are distinct states. Git records describe desired state; only successful UDP/TCP checks on every resolver make a request Live. Lost responses retry the same request ID; a committed failed rollout is reconciled before later changes proceed. Conflict failures require a refreshed save. Raw deployment logs stay on Tools, and credentials are never returned through the API.

The dashboard remains intended for your trusted private network. Keep its write APIs behind your existing private access boundary and never expose the controller SSH key to browser code. Inventory writes require JSON and reject cross-origin browser requests; originless JSON requests remain available to local integrations.

Validate with `npm test`, `RUN_DB_TESTS=1 node --test tests/*.test.js` (temporary Postgres tables), and `npm run build`.

Install dependencies:

```bash
npm install
```

Set `DATABASE_URL` in your environment before running the app or import scripts.

## Development

```bash
npm run dev
```

Development uses `.nuxt/`; production builds and generation use `.nuxt-build/` and
emit the deployable app to `.output/`. This keeps `npm run build` from deleting or
replacing the files used by a running dev server. Nuxt owns its internal module
aliases; do not map `#internal/nuxt/*` to generated files in `package.json`.

After installing this configuration change, restart an already-running dev server
once. Normal page/component edits should then hot reload, including after a
production build. For development type generation, use
`npx nuxt prepare --envName development` (also run by `npm install`).

## Build

```bash
npm run build
```

## UniFi address management and DNS consistency

The device editor replaces manual assignments with the current/last-reported UniFi
address, assignment mode, network, and observation time. Configured reservations
are distinct from observed addresses. Client reservations and adopted switches/APs
with supported management settings can be changed through **Change address**.
Gateways and devices without supported settings remain read-only with a UniFi link.
Network/VLAN changes and forced reconnects are intentionally excluded.

The fixed-IP picker lists existing reserved ranges in the current UniFi subnet,
with paged available addresses and optional custom IPv4 entry. Live observations,
offline reservations, gateways, and in-flight assignments block conflicting
choices. Availability is rechecked before each write. A stale settings revision
requires refresh. Only allowlisted network metadata is persisted; controller
credentials and full management payloads never enter browser responses.

The inventory's **More filters → DNS mismatch** filters affected devices. Device rows and
the editor compare actual imported DNS records for the managed hostname against
all UniFi-reported addresses. Missing/error sources show **Unable to compare**;
missing records, pending updates, and failed updates have separate states. Existing
hostname bindings survive address changes, keeping old DNS answers visible.

UniFi writes are durable jobs processed by the existing `npm run dns:worker`
service every ten seconds while work is pending. Restart that service after
updating its code. Jobs preserve expected settings, reconcile lost responses
before replay, wait for fresh connected-device observation, and separately track
DNS completion. Multiple dashboard assignments for a device/address are prevented
by database constraints and a worker/API advisory lock.

Only dashboard-initiated changes automatically move an existing managed DNS
record, after UniFi reports the replacement address in use. Switching to Automatic
waits for an observed changed address. Changes made directly in UniFi or unrelated
DHCP changes are flagged; **Update DNS** previews and explicitly
reconciles them. IPv6 remains visible but assignment editing and DNS publishing
are IPv4-only. Inventory edits do not silently create DNS records for new addresses.

Automatic and explicit DNS reconciliation require the companion controller and
resolver upgrade in [integrations/dns-platform/README.md](integrations/dns-platform/README.md).
The controller and all three resolver helpers were upgraded on 2026-10-18 and
the dashboard has verified `hostname.move` support. See the companion deployment
record for validation and recovery copies. On older installations, DNS sync
shows an actionable failure and retains successful UniFi settings until every
resolver advertises support. Existing aliases move with the source record; shared/multiple
answers require reconciliation. Revision and concurrent-hostname conflicts never
overwrite newer changes. Failed DNS deployments retain the existing retry flow.

New device APIs under `/api/inventory/devices/:id/`:

- `GET unifi`: cached device, assignment, DNS comparison, and operation status.
- `POST unifi-refresh`: read fresh UniFi evidence and refresh DNS without changing device settings.
- `GET unifi-availability?rangeId=...&offset=...`: range availability (50 choices/page), with first pages included for all compatible ranges. Controller reads are coalesced and cached for up to 20 seconds; availability reads do not import inventory. Assignment submissions always bypass this cache for fresh validation.
- `POST unifi-assignment`: `{mode: "fixed"|"automatic", ip?, expectedRevision}`.
- `POST dns-reconcile`: `{targetIp, expectedRevision}`; explicitly moves existing DNS.

Existing inventory response shapes remain, with `unifi`, `unifiUrl`, and
`dnsComparison` added. `assignedIps` is an empty compatibility field. Generic
create/update requests containing `primaryIp`, `ips`, `assignedIps`, or
`ipAssignments` are rejected; network ownership must be changed in UniFi.

Preview the legacy IP projection rebuild with `npm run unifi:rebuild-ips`.
Apply with `npm run unifi:rebuild-ips -- --apply`; it saves previous IP projections
in `.data/repairs/unifi-ips-*.json`, updates transactionally, and preserves all
manual records and device metadata. Rerun the preview and expect zero changes.
The collector maintains the same projection on every complete successful import.

The device editor presents the IP, assignment type, and **Update IP** together. UniFi provenance and refresh controls live under **Connection details**. DNS uses a small status icon; warnings expand to show the actual comparison and repair controls. Controls remain visible during availability checks, range pages are reused briefly, and cancelled or superseded requests cannot replace the active selection.

Device details resolve MAC hardware information offline from the bundled IEEE
MA-L, MA-M, MA-S and legacy IAB public registries in `data/mac-vendors.json`.
The manufacturer/registrant and address type appear below the MAC; expand
**IEEE registration** for the assigned block, registrant address, source and
snapshot timestamp. A registration identifies the MAC block owner, which can
be a network adapter supplier; it does not establish the device model or location.
Private/locally administered, multicast, broadcast and unspecified addresses
are classified without claiming a manufacturer. No device MAC is sent to an
external lookup service, and changing a MAC immediately recalculates its hardware
information in detail API responses.

Refresh the bundled snapshot with `npm run mac:update` (or
`node scripts/update-mac-vendors.js`), then rebuild/restart the app. The updater
downloads the [IEEE public listings](https://standards.ieee.org/products-programs/regauth/),
validates every registry and replaces the snapshot only after all downloads succeed.

### Manual device merging

Open the device to keep and choose **Merge another device into this one**.
Search by name, IP, or MAC, select a duplicate, review the preview, and confirm.
Repeat to combine additional records. Existing metadata on the kept record wins;
empty fields are filled, notes are combined, and tags, saved addresses, linked
sources, allocations, and completed operation history move to the kept device.
Conflicting address annotations remain with the kept record. Network/DNS settings
upstream are unchanged. Different managed DNS hostnames and active network/DNS
jobs block merging until resolved.

Merges run in one transaction and reject previews if either record or its
associations changed. `device_merge_history` stores original rows and associations
for administrator recovery; there is no automatic undo. `device_merge_aliases`
retains old IDs, keys, and MAC identities. Old detail links resolve to the kept
device, existing source mappings become manual, and subsequent imports recognize
the merged MACs even if upstream source IDs change. The kept device's primary MAC
selects its UniFi settings; all imported interfaces contribute addresses.

`POST /api/inventory/devices/:id/merge` with `{otherId}` returns a preview and
revision. Submit `{otherId, revision, apply: true}` to apply it. The normal
same-origin JSON protections apply. Merge integration tests use temporary tables
and roll back: `$env:RUN_DB_TESTS='1'; node --test tests/*.test.js` in PowerShell.

### Editing network definitions

On `/network`, use **Edit** on a VLAN or reserved range, then save or cancel.
Edits retain the database ID and existing references. `PUT /api/inventory/vlans/:id`
and `PUT /api/inventory/reserved-ranges/:id` accept the same fields as creation.
Creation rejects duplicate VLAN numbers and range slugs instead of overwriting.
VLAN numbers must be 1–4094. VLAN subnets must be valid network CIDRs.
Reserved ranges cannot overlap other reserved ranges (including shared endpoints),
and VLAN subnets cannot overlap other VLAN subnets. IPv4 and IPv6 are supported;
a reserved range may sit inside a VLAN. Validation and writes share a transaction
and table lock to serialize simultaneous saves. Existing legacy definitions remain
readable; conflicting definitions must be corrected before saving an edit.
