# Install, use, uninstall, rollback

Target: DSH Desktop v2.0.11 (community app, anywhere-labs) bundling DeepSeek
Harness v0.1.5-rc.2, with the `desktop` profile at `~/.dsh/profiles/desktop`
and user presets under `~/.dsh/.agent-presets/`.

All commands below are relative to a clone of this repository. Run them from
anywhere; the installer resolves its own assets relative to itself.

## 1. Build, verify, pack

```sh
git clone git@github.com:Qulierm/orbital-agents.git
cd orbital-agents
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build
pnpm pack                     # dsh-orbital-agents-0.2.2.tgz
node scripts/pack-check.mjs   # tarball contents, no secrets/sources
node scripts/preset-check.ts  # preset contract + persona drift
```

## 2. Install the package and the user preset

```sh
node scripts/install-local.mjs --tarball ./dsh-orbital-agents-0.2.2.tgz
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
3. **Bundle row** — `dsh-orbital-agents` is appended to `dsh.profile.bundles` only
   when absent; existing entries and their order are preserved.
4. **User preset** — `preset/endeavour/` is copied atomically to
   `~/.dsh/.agent-presets/endeavour/`, gets the ownership marker
   `.dsh-endeavour-owned`, and a `node_modules/dsh-orbital-agents` symlink to the
   installed package so the preset's scoped tools row resolves.

Re-running install is idempotent. If the target preset exists without our
ownership marker, the installer **refuses** and leaves it untouched; pass
`--force` to replace it (a backup is taken first).

### Manual restart versus scheduled restart

Restarting by hand is always safe. When an agent has to restart the app it must schedule it instead of
performing it inside the same call, because quitting DSH Desktop kills the host that owns that call:
DSH records the call as interrupted with an unknown outcome and any pending report is never delivered.

```
node scripts/schedule-desktop-restart.mjs --delay-seconds 45
# prints: schedule-desktop-restart: scheduled id=<id> delay=45s log=~/.dsh/backups/endeavour/restarts/<id>.log
```

The call returns immediately (the public floor is 30 seconds); the detached worker then records
`requested`, `quit`, `open` and `ready`/`failed` in that log. Report `restart scheduled` with the id and
log path and stop — the log, not the report, carries the post-restart outcome.

## 3. Restart and use

```sh
osascript -e 'quit app "DSH Desktop"'
open "/Applications/DSH Desktop.app"
```

Then, in the app: **New Chat → Endeavour preset → choose the Planner model →
describe the task in ordinary language → send**. Watch the plan card; use
**Open Challenger** to follow the paired executor chat. The first message is the only step that
requires provider credentials; no LLM request is made by the installer or the
verification flow.

Restart behavior: profile bundle rows and preset rows are mounted at startup,
so restart the app after install/update. Preset discovery itself is re-read on
every roster read, but a restart is the safe path; already-running sessions
keep their existing scope.

## 4. Peer presets

The installer places **two** owned presets, `~/.dsh/.agent-presets/endeavour`
and `~/.dsh/.agent-presets/challenger`, each linking
`node_modules/dsh-orbital-agents`. Endeavour mounts the planner catalog
(`endeavour_plan`, `endeavour_verify`); Challenger mounts the executor catalog
(`challenger_start_task`, `challenger_report`) and keeps the full coding tool
surface with no delegation or ordinary messaging tools. Uninstall removes both
owned presets; rollback restores both exact prior states.

`preset-check` validates both personas, both role mounts, the coding rows, and
the absence of subagent/delegation mounts.

## 5. Upgrading from the predecessor package

Earlier releases shipped as `dsh-endeavour`. The installer treats that name as a known, owned
predecessor and migrates it in one run, without touching anything it does not own:

1. removes the predecessor package from the profile (`pnpm remove dsh-endeavour`);
2. rewrites its `dsh.profile.bundles` row to `dsh-orbital-agents` **in place**, so the row is never
   duplicated and unrelated bundles keep their order;
3. installs `dsh-orbital-agents` and links `node_modules/dsh-orbital-agents` into the owned presets,
   removing the predecessor's link from the same directory;
4. leaves every other bundle, package and user-authored preset exactly as it was.

The `.dsh-endeavour-owned` marker keeps working as the ownership marker, so presets installed by the
predecessor are still recognised as ours (and are still never confused with a user's own preset).
Durable identities stay on the predecessor spelling on purpose — recorded events (`endeavour/plan`,
`endeavour/peer`), the deterministic pair/challenger ids, the injected CSS class namespace and the
backup directory (`~/.dsh/backups/endeavour/`) are unchanged, so existing sessions, pairs, styles and
backups keep working. `--uninstall` and `--rollback` clear both the new and the predecessor bundle
rows.

## 6. Model selection

The paired Endeavour composer carries one unified control that configures the
**Endeavour** and **Challenger** model and thinking routes from a single menu;
see [configuration.md](configuration.md). The retired Builder-route flags are
rejected by the installer. Installation first runs a read-only legacy-plan
preflight: a nonterminal `childId`-only plan aborts the install with the
affected session ids and remediation (terminal historical plans are allowed).

## 7. Uninstall and rollback

```sh
# remove plugin, bundle row, and only the preset this package owns
node scripts/install-local.mjs --uninstall

# list backups, then restore profile files + preset state exactly
node scripts/install-local.mjs --list-backups
node scripts/install-local.mjs --rollback <timestamp>
```

Ownership rules: uninstall removes `~/.dsh/.agent-presets/endeavour` only when
it carries `.dsh-endeavour-owned`; a user-authored preset is never deleted.
Rollback restores the backed-up profile files and the exact prior preset state
(including "no preset existed before" by removing the owned one). If anything
fails mid-install, the installer rolls partial profile/preset changes back
automatically.

Never disable Gatekeeper, remove quarantine flags, edit the app bundle, or use
sudo for any of these operations.
