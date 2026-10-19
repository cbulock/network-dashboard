# DNS Platform address movement

The original controller's `hostname.set` operation refuses to move an existing
name. The dashboard therefore requires `hostname.move` and never falls back to
creating a competing DNS answer. Until this upgrade is installed, a successful
UniFi assignment is retained and the dashboard shows a retryable DNS error.

The upgrade was deployed and verified on 2026-10-18 at commit
`d83ccd79d2a823147cda24f1ada09844eb68a25b`. The Tools controller and the HA, Tools,
and NAS6 resolver helpers advertise `hostname.move`; the dashboard has imported
that capability. See [DEPLOYMENT.md](DEPLOYMENT.md) for validation and recovery.

`hostname-move.patch` is the exact deployed Git patch. The adjacent Python sources
are the resulting controller, resolver, transition helper, legacy validator, and
tests for review. Applying this package elsewhere requires the deployment steps below.

## Contract

Request: `operation: "hostname.move"`, UUID `id`, `hostname`, `fromIp`, `ip`,
and `expectedRevision`. Normal idempotency, revision checks, durable deployment,
backups, serial resolver updates, and UDP/TCP verification remain in place.

Movement transfers the complete source address record, including its aliases,
to the destination. Existing destination aliases are retained. Shared names at
other addresses require manual reconciliation. The resolver allows only the
exact authorized transition; unrelated answer removals remain forbidden. A
resolver that already applied the candidate accepts an idempotent retry.

Every explicit movement also commits `config/address-moves.json`, recording the
request ID, original/destination address, and source aliases. Legacy validation
follows those approved moves while requiring every alias, so subsequent hostname
edits and CI continue to pass. The migration-importer fixture deliberately ignores
the ledger because it reconstructs original addresses. Resolver transition checks
still permit only the exact approved movement.

## Installation and verification

1. In a clean DNS Platform checkout, run `git apply --check /path/to/hostname-move.patch`,
   then apply the patch. The patch includes installer, validator, runbook, and tests.
2. Run its existing controller tests, the new movement tests, and `scripts/validate.sh`.
3. Follow that repository's `docs/runbooks/dashboard-controller.md` upgrade procedure.
   Install `move_records.py` alongside both controller and resolver helper scripts.
   Upgrade all resolver endpoints before enabling the new controller code. Coordinate
   service restart with active jobs using the existing recovery procedure.
4. Verify each resolver's read-only `health` response includes `hostname.move` in
   `capabilities`. The controller advertises that capability in `records.list`
   only when every configured resolver supports it.
5. After the upgrade, retry the dashboard's failed DNS synchronization. A live
   address-movement test requires a deliberately selected device and address;
   tests in this repository do not change live UniFi or DNS configuration.
