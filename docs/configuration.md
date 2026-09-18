# Challenger model configuration

The persistent Challenger owns the model selection of its own ordinary session.
There is no "next child" route preference any more: the retired
`endeavour-builder` settings namespace is removed by the installer (with a
per-run backup) and the old Builder-route CLI flags are gone.

## Composer control

The root Endeavour composer shows a `Challenger | model · effort` control next
to the Endeavour model selector. It mirrors the paired Challenger session's
`modelSelection` projection and writes through the official
`remote.session.selectModel` for that session, so:

- selecting a model or an effort changes the CHALLENGER session only;
- the Challenger's own native ModelSelect updates reactively, and this mirror
  follows changes made there;
- the Endeavour route is never touched and no session is ever recreated.

The control is visible only on the paired Endeavour side of a valid pair, is
disabled while a plan is active or the turn is running, and hides itself in
Standard chats, in the Challenger session and outside the pair. The Challenger
session keeps its own native selector as the single local control.

## Peer presets

Two owned presets are installed and linked:

- `endeavour` — planner catalog: `endeavour_plan`, `endeavour_verify`;
- `challenger` — executor catalog: `challenger_start_task`,
  `challenger_report`, plus the ordinary coding tools (no delegation and no
  ordinary messaging tools).

A plan reuses the persistent Challenger with its current selection; later plans
on the same pair do the same. Terminal historical plans recorded before the
peer runtime stay readable as history.

## Blank peer navigation

A peer with no turns yet has no native View ring in rc.2, so the composer shows
a role-aware plan action (Open Challenger / Open Endeavour) and, while no plan
is projected on the Challenger side, a restrained `Endeavour` return button in
the composer dock. Both open the exact counterpart through the official
`ISessions.open` bridge; see [architecture.md](architecture.md).

## Retired flags

`--configure-builder`, `--show-builder` and `--reset-builder` were removed.
The installer rejects them (and any other unknown flag) with a clear message and
changes nothing. `--tarball`, `--profile`, `--rollback`, `--force`,
`--uninstall` and `--list-backups` remain.

## Migration

On install the installer first scans the real session storage read-only and
refuses to continue while a NONTERMINAL legacy (`childId`-only) plan exists,
listing the affected sessions and the remediation (finish it with the previous
plugin version, or archive/cancel it explicitly). Terminal legacy plans are
allowed and stay readable. After the scan it removes only the retired
`endeavour-builder` block from `~/.dsh/settings.yaml`, after backing the file up;
unrelated settings keys are never touched.
