# Orbital Agents

Two coordinated DSH agents that plan and execute as one pair. **Orbital Agents** is the project and
repository identity; the installable plugin keeps the package name **`dsh-endeavour`**.

The **Endeavour** agent investigates, writes the plan, and verifies results. Its persistent
**Challenger** peer is a second ordinary chat that executes the plan and reports back through a
durable protocol. The pair is created once and reused for every later plan, so the two agents stay in
the same orbit instead of being re-spawned per task.

- Target runtime: DeepSeek Harness **v0.1.5-rc.2** (Cordis 4.0.2), the family bundled by the
  third-party community **DSH Desktop v2.0.11**. This is a community integration; it is not an
  official DeepSeek product.
- The global bundle only provides the durable orchestration service. The four model-facing tools are
  registered by the scoped `dsh-endeavour/tools` row of the **Endeavour** preset, so the standard
  preset never sees them.
- User-visible task states are exactly four: waiting, running, succeeded, failed — shown as
  `Waiting to start`, `Working`, `Finished`, `Confirmed`, and `Failed` display stages.
- Only Endeavour records success or failure after a quick acceptance check; the Challenger can never
  authorize terminal success.

## Use it

1. Install the package and the user presets (see below), then restart DSH Desktop so the profile
   bundle row and the presets are loaded:
   `osascript -e 'quit app "DSH Desktop"'` then `open "/Applications/DSH Desktop.app"`.
2. Start a **New Chat** and pick the **Endeavour** preset.
3. Choose the planning model normally in the composer (ordinary model selection), and use the
   unified model control — one icon-only button that opens Model/Thinking rows for **Endeavour** and
   **Challenger** separately.
4. Describe the task in ordinary language and send it. This is the only step that needs provider
   credentials.
5. Watch the plan card in the Endeavour chat: progress, the durable task states, a live timer per
   running task, and the frozen duration after verification. `Open Challenger` opens the paired chat
   that executes the tasks.

Two ordinary presets ship together: **Endeavour** (planner: `endeavour_plan`, `endeavour_verify`)
and **Challenger** (executor: `challenger_start_task`, `challenger_report`). A plan is delivered once
to the persistent Challenger session paired with its Endeavour session; the companion is never a
subagent and is reused by every later plan of that pair.

A paired Endeavour session shows a native `Challenger` view tab next to `Chat` and `Trajectory`, and
the Challenger session shows the reciprocal `Endeavour` tab; either tab opens the other ordinary
session of the pair (see [docs/architecture.md](docs/architecture.md)).

## Install

```sh
git clone git@github.com:Qulierm/orbital-agents.git
cd orbital-agents
pnpm install --frozen-lockfile
pnpm run build
pnpm pack
node scripts/install-local.mjs --tarball ./dsh-endeavour-0.2.0.tgz
```

The installer backs up the desktop profile and any existing user preset first, installs the package
into `~/.dsh/profiles/desktop`, preserves existing plugin order, and installs the owned user presets
at `~/.dsh/.agent-presets/endeavour` and `~/.dsh/.agent-presets/challenger`. Re-running it is
idempotent; a changed tarball at the same name/version still refreshes the installed artifact
(remove-before-add). See [docs/install.md](docs/install.md) for the full lifecycle.

## Model selection

The composer carries one unified control: a single icon-only button (id `endeavour-models`) that opens
a menu with an **Endeavour** section and a **Challenger** section, each with its own **Model** and
**Thinking** rows. Both roles are configured from that one menu and stay independent:

- every read, subscription, catalog load and write goes through the official model directory of the
  target session — the Endeavour session the control is rendered in, and its paired Challenger;
- choosing a model writes through that role's directory and resets only that role's thinking effort
  to the model's catalog default;
- the host's native Endeavour selector is hidden by CSS only while the unified control is rendered,
  so Standard and unpaired chats keep their ordinary selector;
- while a plan is active the whole control is disabled, which keeps every route frozen for the run.

A temporary gap in the paired-session projection cannot unmount the control: admission is latched
after the pair is first seen, and the validated Challenger identity is retained, so a role whose
model directory is briefly unavailable shows a local unavailable/retry state instead of a vanished
control. See [docs/configuration.md](docs/configuration.md).

## Lifecycle

- Backups live in `~/.dsh/backups/endeavour/<timestamp>/` (`profile/`, `preset/`, `state.json`).
- `--list-backups` lists them; `--rollback <timestamp>` restores the profile files and preset state
  exactly.
- `--uninstall` removes the plugin, its bundle row, and only a preset this package owns (an existing
  user-authored preset is left untouched).
- Conflicts: an existing non-owned preset is never overwritten; pass `--force` to replace it after
  the automatic backup.
- Installation first runs a read-only legacy-plan preflight over the real session storage: a
  NONTERMINAL `childId`-only plan aborts the install (with the affected session ids and remediation)
  before any mutation; terminal historical plans are allowed and stay readable.

See [docs/install.md](docs/install.md) for the full lifecycle and
[docs/architecture.md](docs/architecture.md) for the invariants.

## License

MIT — see [LICENSE](LICENSE).
