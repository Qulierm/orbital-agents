# dsh-endeavour

Standalone DSH plugin: one durable Endeavour plan, one continuable Builder
child, and a replayable plan card inside the Endeavour Chat.

- Target runtime: DeepSeek Harness **v0.1.5-rc.2** (Cordis 4.0.2), the family
  bundled by the third-party community **DSH Desktop v2.0.11**. This is a
  community integration; it is not an official DeepSeek product.
- The global bundle only provides the durable orchestration service. The four
  model-facing tools are registered by the scoped `dsh-endeavour/tools` row of
  the **Endeavour** preset, so the standard preset never sees them.
- User-visible task states are exactly four: waiting, running, succeeded,
  failed — rendered as "Ожидает начала", "Выполняется", "Выполнился успешно",
  "Не выполнился".
- Only Endeavour records success or failure after a quick acceptance check; the
  Builder can never authorize terminal success.

## Use it

1. Install the tarball and the user preset (see below), then restart DSH
   Desktop so the profile bundle row and preset are loaded:
   `osascript -e 'quit app "DSH Desktop"'` then
   `open /Applications/DSH\ Desktop.app`.
2. Start a **New Chat** and pick the **Endeavour** preset.
3. Choose the **Planner model** normally in the composer (ordinary model
   selection).
4. Describe the task in ordinary language and send it. This is the only step
   that needs provider credentials.
5. Watch the plan card in the Endeavour chat: progress, the four task states,
   a live timer per running task, and the frozen duration after verification.
   `Open Builder` opens the child that executes the tasks.

Two ordinary presets ship together: **Endeavour** (planner: `endeavour_plan`,
`endeavour_verify`) and **Challenger** (executor: `challenger_start_task`,
`challenger_report`). A plan is delivered once to the persistent Challenger
session paired with its Endeavour session; the companion is never a subagent and
is reused by every later plan of that pair.

A paired Endeavour session shows a native `Challenger` view tab next to `Chat`
and `Trajectory`, and the Challenger session shows the reciprocal `Endeavour`
tab; either tab opens the other ordinary session of the pair (see
[docs/architecture.md](docs/architecture.md)).

The Challenger owns its own session model selection: the composer control next
to the Endeavour selector mirrors it and writes through the official
`remote.session.selectModel` — see
[docs/configuration.md](docs/configuration.md). There is no inherit/Automatic
route preference any more.

## Install

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --tarball /Users/nikita/Documents/Coding/dsh-endeavour/dsh-endeavour-0.2.0.tgz
```

The installer backs up the desktop profile and any existing user preset first,
installs the package into `~/.dsh/profiles/desktop`, preserves existing plugin
order, and installs the owned user preset at
`~/.dsh/.agent-presets/endeavour`. Re-running it is idempotent; a changed
tarball at the same name/version still refreshes the installed artifact
(remove-before-add).

## Model selection (peer-owned)

The root composer's `Challenger | model · effort` control mirrors the paired
Challenger session's own selection and writes through the official
`remote.session.selectModel` for that session; the Endeavour route is never
touched. The retired Builder-route flags (`--configure-builder`,
`--show-builder`, `--reset-builder`) were removed and are rejected by the
installer — see [docs/configuration.md](docs/configuration.md).

Installation first runs a read-only legacy-plan preflight over the real session
storage: a NONTERMINAL `childId`-only plan aborts the install (with the affected
session ids and remediation) before any mutation; terminal historical plans are
allowed and stay readable.

## Lifecycle

- Backups live in `~/.dsh/backups/endeavour/<timestamp>/` (`profile/`,
  `preset/`, `state.json`).
- `--list-backups` lists them; `--rollback <timestamp>` restores the profile
  files and preset state exactly.
- `--uninstall` removes the plugin, its bundle row, and only a preset this
  package owns (an existing user-authored preset is left untouched).
- Conflicts: an existing non-owned preset is never overwritten; pass
  `--force` to replace it after the automatic backup.

See [docs/install.md](docs/install.md) for the full lifecycle and
[docs/architecture.md](docs/architecture.md) for the invariants.
