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

The Builder route is **inherited** by default. Pick a different one in the
composer chip (`Builder · Inherit`) before sending: choose `Inherit Planner` or
a provider/model with its thinking option. The choice applies to the next
Builder child and is frozen once the plan exists — see
[docs/configuration.md](docs/configuration.md).

## Install

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --tarball /Users/nikita/Documents/Coding/dsh-endeavour/dsh-endeavour-0.1.0.tgz
```

The installer backs up the desktop profile and any existing user preset first,
installs the package into `~/.dsh/profiles/desktop`, preserves existing plugin
order, and installs the owned user preset at
`~/.dsh/.agent-presets/endeavour`. Re-running it is idempotent; a changed
tarball at the same name/version still refreshes the installed artifact
(remove-before-add).

## Builder route

```sh
# show current state (configured values or "inherited")
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --show-builder

# configure a separate Builder route (provider and model are required)
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --configure-builder --provider <provider-id> --model <model-id> \
  [--reasoning-effort <effort-id>] [--max-tokens <n>]

# reset back to inherited
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --reset-builder
```

Configuration writes only the `endeavour` row of the profile patch, backs up
before mutating, and never stores secrets. If nothing is configured, the card
and `--show-builder` both report that the Builder inherits the Planner route;
cost separation requires choosing a cheap route explicitly.

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
