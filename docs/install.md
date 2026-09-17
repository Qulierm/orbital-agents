# Install, use, uninstall, rollback

Target: DSH Desktop v2.0.11 (community app, anywhere-labs) bundling DeepSeek
Harness v0.1.5-rc.2, with the `desktop` profile at `~/.dsh/profiles/desktop`
and user presets under `~/.dsh/.agent-presets/`.

All commands below use the exact repository path of this checkout. Run them
from anywhere; the installer resolves its own assets relative to itself.

## 1. Build, verify, pack

```sh
cd /Users/nikita/Documents/Coding/dsh-endeavour
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build
pnpm pack                     # dsh-endeavour-0.1.0.tgz
node scripts/pack-check.mjs   # tarball contents, no secrets/sources
node scripts/preset-check.ts  # preset contract + persona drift
```

## 2. Install the package and the user preset

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --tarball /Users/nikita/Documents/Coding/dsh-endeavour/dsh-endeavour-0.1.0.tgz
```

What happens, in order:

1. **Backup** — `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `cordis.yml`, `cordis.patch.yml` and any pre-existing
   `~/.dsh/.agent-presets/endeavour/` are copied to
   `~/.dsh/backups/endeavour/<timestamp>/` (`profile/`, `preset/`,
   `state.json`).
2. **Package** — the tarball is installed with `pnpm remove` + `pnpm add` in
   `~/.dsh/profiles/desktop` (no sudo). The remove-first step guarantees a
   changed tarball at the same package name/version refreshes the installed
   artifact instead of pnpm reusing stale content.
3. **Bundle row** — `dsh-endeavour` is appended to `dsh.profile.bundles` only
   when absent; existing entries and their order are preserved.
4. **User preset** — `preset/endeavour/` is copied atomically to
   `~/.dsh/.agent-presets/endeavour/`, gets the ownership marker
   `.dsh-endeavour-owned`, and a `node_modules/dsh-endeavour` symlink to the
   installed package so the preset's scoped tools row resolves.

Re-running install is idempotent. If the target preset exists without our
ownership marker, the installer **refuses** and leaves it untouched; pass
`--force` to replace it (a backup is taken first).

## 3. Restart and use

```sh
osascript -e 'quit app "DSH Desktop"'
open "/Applications/DSH Desktop.app"
```

Then, in the app: **New Chat → Endeavour preset → choose the Planner model →
describe the task in ordinary language → send**. Watch the plan card; use
**Open Builder** to follow the child. The first message is the only step that
requires provider credentials; no LLM request is made by the installer or the
verification flow.

Restart behavior: profile bundle rows and preset rows are mounted at startup,
so restart the app after install/update. Preset discovery itself is re-read on
every roster read, but a restart is the safe path; already-running sessions
keep their existing scope.

## 4. Builder route (optional)

The Builder inherits the Planner route unless you configure a separate one:

```sh
# show configured values or the inherited fallback
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --show-builder

# configure (provider and model are required; values are validated)
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --configure-builder --provider <provider-id> --model <model-id> \
  [--reasoning-effort <effort-id>] [--max-tokens <n>]

# return to inherited
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --reset-builder
```

Each mutation backs up the profile first and touches only the `endeavour` row
of `~/.dsh/profiles/desktop/cordis.patch.yml`. Configuration survives
re-install and rollback. See [configuration.md](configuration.md).

## 5. Uninstall and rollback

```sh
# remove plugin, bundle row, and only the preset this package owns
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --uninstall

# list backups, then restore profile files + preset state exactly
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --list-backups
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --rollback <timestamp>
```

Ownership rules: uninstall removes `~/.dsh/.agent-presets/endeavour` only when
it carries `.dsh-endeavour-owned`; a user-authored preset is never deleted.
Rollback restores the backed-up profile files and the exact prior preset state
(including "no preset existed before" by removing the owned one). If anything
fails mid-install, the installer rolls partial profile/preset changes back
automatically.

Never disable Gatekeeper, remove quarantine flags, edit the app bundle, or use
sudo for any of these operations.
