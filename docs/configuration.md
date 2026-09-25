# Model configuration

Each ordinary session of the pair owns the model selection of its own route. There
is no "next child" route preference: the retired `endeavour-builder` settings
namespace is removed by the installer (with a per-run backup) and the old
Builder-route CLI flags are gone.

## Unified composer control

The paired Endeavour composer carries ONE unified model control: a single icon-only
button (slot id `endeuvre-models`, order 1000) that opens a menu with two
sections — **Endeavour** and **Challenger** — each with its own **Model** and
**Thinking** rows.

Admission to that control is persistent and owned by the per-session client
controller, so the trigger and the CSS marker that hides the host's native
selector survive a null or malformed projection, a slot remount and a directory
failure. The trigger is a stable shell that performs no model-directory
operation; every role availability read, subscription, catalog load and write
lives in the menu subtree below a menu-only error boundary, and all of them run
after commit from the snapshot effect rather than while rendering — probing a
directory lazily can publish composer/session changes, and doing that during a
render nests an update inside a render. An unexpected
exception there leaves the trigger mounted, keeps the native selector hidden and
offers a localized retry that remounts just the menu, while an expected
missing-scope or missing-binding error stays a per-role unavailable state with
both role sections still visible.

- Every read, subscription, catalog load and write goes through the official
  model directory of the target session: the Endeavour session the control is
  rendered in, and its paired Challenger. The two roles never share mutable
  selection state and no session is ever created or recreated.
- Choosing a model writes through that role's directory and resets only that
  role's thinking effort to the model's catalog default; choosing an effort
  preserves the model of that role.
- Menu rows always show the full catalog names; a failure to load or write is
  reported inside the menu and leaves the displayed selection untouched.
- The control is visible only on the paired Endeavour side of a valid pair; the
  host's native Endeavour selector is hidden by CSS only while this control is
  rendered, so Standard chats, unpaired sessions and the Challenger side keep
  their ordinary selector.
- While a plan is active the whole control is disabled, which freezes every
  route for that run. A running turn disables it the same way instead of hiding
  it.
- The control is admitted once the pair is first seen and then latched: a
  temporary gap in the `endeavourPeer` projection cannot unmount it, and the
  validated Challenger identity is retained, so the native selector never
  becomes a fallback. A role whose directory is briefly unavailable shows a
  local unavailable/retry state inside the menu.

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
the composer dock. Both open the exact counterpart through the `uiWorkspace.openSession`
bridge; see [architecture.md](architecture.md).

## Pair codes and titles

Every durable pair has a deterministic six-character code derived from its pair
id (SHA-256 over the pair identity, rendered in an unambiguous alphabet without
`I`, `O`, `0` or `1`). Both members are titled through the official session-title
service:

- the **Endeavour** side keeps its meaningful title and gains the prefix, so
  `Send hi to builder` becomes `[CODE] Send hi to builder` (a blank session
  becomes `[CODE] Endeavour`);
- the **Challenger** side is canonically `[CODE] Challenger`;
- an older/different pair prefix is *replaced*, never nested, and the correct
  prefix is a no-op.

Titles are applied with the official user rename (which pins them), so a
provider-generated title can never overwrite the pair label. Several pairs in
one workspace therefore stay visually distinct in the sidebar.

## Challenger permission policy

The persistent Challenger always runs with the `danger-full-access` permission
preset: **unrestricted host filesystem and process access with no approval
prompts**, because it executes the approved plan autonomously. The preset is
applied through the official permission-preset service on creation, adoption and
every existing-pair repair, and it is re-asserted immediately before each
`plan-ready` delivery. If the guarantee cannot be made, delivery is withheld and
the outbox fact stays pending — execution never starts under a downgraded mode.

The Endeavour session is never given a different preset: it keeps whatever
permission the user selected for it.

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
