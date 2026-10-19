# DNS address movement deployment

Verified on 2026-10-18. Deployed commit:
`d83ccd79d2a823147cda24f1ada09844eb68a25b` in `cbulock/dns-platform`.

## Installed and verified

- Controller: `tools.docker`, `/opt/dns-platform-controller/repo`;
  `dns-platform-controller.service` running.
- Resolver helpers: `ha.docker`, `tools.docker`, `nas6.bulock`, in
  `/usr/local/lib/dns-platform-node`.
- Each resolver reports healthy and advertises `hostname.move`.
- Controller `records.list` advertises `hostname.move` only after all three
  resolver capability checks pass. The dashboard imported that capability.
- The local **Network Dashboard DNS Worker** task was drained, paused for the
  upgrade, and resumed after verification.
- Fifteen controller tests pass on Linux, including a committed address move
  followed by a later hostname edit. The full repository validation suite passed
  with the administrative Docker runtime, including runtime container checks,
  record validation, compose validation, Ansible syntax checks, and lint.
- Existing DNS answers were checked over UDP and TCP on each resolver. Record
  and AdGuard configuration hashes stayed unchanged. No live device IP change
  or DNS answer movement was needed for this code deployment.

Automatic synchronization now follows dashboard-initiated IP changes after
UniFi reports the changed address. Changes originating elsewhere still require
explicit DNS reconciliation through the dashboard.

## Recovery copies

Tools deployment directory:
`/var/lib/dns-platform/upgrades/hostname-move-20261018-00547af4`.
It contains the pre-upgrade Git bundle, SQLite jobs backup, isolated validation
checkout, and validation logs. The previous controller checkout was `142c218`.

Each resolver has its previous endpoint scripts and configuration fingerprints
under `/var/lib/dns-platform-node-upgrades/hostname-move-20261018-00547af4`.
These contain code and hashes; production resolver configuration was not replaced.

If rollback becomes necessary, first pause the dashboard worker and reconcile
all pending/deploying or committed failed controller jobs. Preserve their latest
state; do not restore the old SQLite backup over new jobs. Use the controller
lock and stop procedure from the main runbook before changing code. Revert the
upgrade through Git and restore the backed-up resolver helper under each
resolver's existing controller lock. Old helpers remove movement capability,
so the dashboard safely gates future moves. If any real address moves have
already occurred, retain the address-move ledger and its validator support;
blindly restoring the original validator would reject those authorized changes.
