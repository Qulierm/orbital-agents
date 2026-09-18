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
pnpm pack                     # dsh-endeavour-0.2.0.tgz
node scripts/pack-check.mjs   # tarball contents, no secrets/sources
node scripts/preset-check.ts  # preset contract + persona drift
```

## 2. Install the package and the user preset

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --tarball /Users/nikita/Documents/Coding/dsh-endeavour/dsh-endeavour-0.2.0.tgz
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

## 4. Peer presets

The installer places **two** owned presets, `~/.dsh/.agent-presets/endeavour`
and `~/.dsh/.agent-presets/challenger`, each linking
`node_modules/dsh-endeavour`. Endeavour mounts the planner catalog
(`endeavour_plan`, `endeavour_verify`); Challenger mounts the executor catalog
(`challenger_start_task`, `challenger_report`) and keeps the full coding tool
surface with no delegation or ordinary messaging tools. Uninstall removes both
owned presets; rollback restores both exact prior states.

`preset-check` validates both personas, both role mounts, the coding rows, and
the absence of subagent/delegation mounts.

## 5. Model selection (peer-owned)

The root composer mirrors the persistent Challenger's own model selection; see
[configuration.md](configuration.md). The retired Builder-route flags are
rejected by the installer. Installation first runs a read-only legacy-plan
preflight: a nonterminal `childId`-only plan aborts the install with the
affected session ids and remediation (terminal historical plans are allowed).

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
