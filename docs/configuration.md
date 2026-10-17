# Model configuration

Each ordinary session of the pair owns the model selection of its own route. There
is no "next child" route preference: the retired `endeavour-builder` settings
namespace is removed by the installer (with a per-run backup) and the old
Builder-route CLI flags are gone.

## Model controls

The Endeavour composer keeps DSH's native selector and adds one custom Challenger selector beside it:

- DSH registers its Endeavour selector in the single-occupancy `conversation.input.model` seat; this plugin does not hide, restyle, replace or unregister it.
- The custom selector (`id` `endeavour-challenger-model`, order 1000) registers only in the multi-entry `conversation.input.right` list, immediately left of the native seat, and configures the paired Challenger.

The native model seat accepts one registration per priority, so the custom control never registers there.

The custom button uses the native 28px height, 13/20 regular type, 4px gap, `0 4px 0 8px` padding, `--dsw-radius-sm` radius, transparent idle background, secondary label colour, hover and focus tokens, and a decorative rotating chevron. Its visible label is always **Challenger**; the tooltip and accessible description carry the current model, effort and pending status. The popup has Model and Effort rows at the native 34px root-row metric (13/20 type, `0 8px` padding, 6px gap, `--dsw-radius-md`) inside the native 240–420px viewport-constrained card at z-index 1100, with prominent elevation, `--dsw-radius-lg` and a separate noninteractive material layer.

An explicit Endeavour root receives the selector before a Challenger peer exists. In this draft mode, the client reads the root's current model selection and catalog only to supply the initial value; it never writes to the root. The user can choose a model and effort while the peer is unavailable.

The client stores a pre-peer choice in this desktop browser's local storage, scoped to the browser origin and exact Endeavour root session. The record contains only provider, model and optional reasoning effort. It is not synchronized with the DSH host or another browser origin, and storage read/write failures remain visible in the menu.

When the exact validated Challenger peer becomes ready, the client applies the matching pending revision through that peer's official model directory. A successful application removes only that revision; a rejected selection or storage-removal failure leaves the choice pending and retryable. The client never creates or recreates a session for this control.

A saved choice affects requests assembled after application. It does not guarantee a request already begun will use the new model, cancel or retarget that request, or change plan routing or task state. The selector remains enabled during plans and running turns.

### Pending-selection storage

Each save and conditional removal takes a native exclusive Web Lock named by the same origin- and root-scoped localStorage key. While holding the lock, the store rereads durable storage; it removes a pending choice only if its revision is still current. The browser must expose `navigator.locks`, normally in a secure context. If Web Locks or storage access is unavailable, mutations fail closed and the menu reports an error; there is no unlocked fallback.

Reload every open DSH tab after installing or updating so each tab runs the lock-enabled code. The lock coordinates only updated tabs on the same origin using this exact key. Older plugin tabs and other code that writes localStorage without the lock do not participate, so this does not provide atomicity against arbitrary writers. The record remains local to this browser origin and exact Endeavour root session. See the [locking decision](decisions/2026-10-17-pending-selection-locking.md) for the rationale and alternatives.

The peer directory resolves only for a session with a live scope and UI binding, and the host does not bind a peer merely by running it. While mounted, the control retains the exact validated Challenger through the official sessions service (`retain`, source `orbitalModelMenu`), waits for readiness, then reads, subscribes and loads its catalog. It releases that reference on unmount, retry, session/controller change or lost admission, after disposing the matching subscription. A peer that cannot be retained or opened shows a local unavailable/retry state while the trigger remains mounted; a host without `retain` uses the directory lookup alone.

The selector appears only for an admitted Endeavour root. Standard sessions, known subagents and Challenger-side sessions do not receive it. A gap in the peer projection does not discard an already admitted root.

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
