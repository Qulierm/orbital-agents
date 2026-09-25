# Install, use, uninstall, rollback

Target: DSH Desktop v2.0.14 (community app, anywhere-labs) bundling DeepSeek
Harness v0.1.7-rc.1, with the `desktop` profile at `~/.dsh/profiles/desktop`.
Presets are bundle composition rows in that harness, not directories under
`~/.dsh/.agent-presets`.

All commands below are relative to a clone of this repository. Run them from
anywhere; the installer resolves its own assets relative to itself.

## 1. Build, verify, pack

```sh
git clone git@github.com:Qulierm/orbital-agents.git
cd orbital-agents
pnpm install --frozen-lockfile
pnpm run typecheck && pnpm test && pnpm run build
pnpm pack                     # dsh-orbital-agents-0.2.5.tgz
node scripts/pack-check.mjs   # tarball contents, no secrets/sources
node scripts/preset-check.ts  # preset contract + persona drift
```

`pnpm run build` also projects `preset/<id>/` into `presets/<id>.patch.yml`, the
generated patch files the package declares in `dsh.bundle.patch`.

## 2. Install the package and its presets

```sh
node scripts/install-local.mjs --tarball ./dsh-orbital-agents-0.2.5.tgz
```

What happens, in order:

1. **Backup** — `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
   `cordis.yml`, `cordis.patch.yml` and any pre-existing owned preset
   directories are copied to `~/.dsh/backups/endeavour/<timestamp>/`
   (`profile/`, `preset-<id>/`, `state.json`).
2. **Package** — the tarball is installed with `pnpm remove` + `pnpm add` in
   `~/.dsh/profiles/desktop` (no sudo). The remove-first step guarantees a
   changed tarball at the same package name/version refreshes the installed
   artifact instead of pnpm reusing stale content.
3. **Bundle row** — `dsh-orbital-agents` is appended to `dsh.profile.bundles` only
   when absent; existing entries and their order are preserved.
4. **Preset retirement** — the package ships both presets as bundle patches
   (`presets/endeavour.patch.yml`, `presets/challenger.patch.yml`), so the
   installer writes no preset directory. It removes the ownership-marked
   directories earlier releases installed under `~/.dsh/.agent-presets/`; a
   user-authored preset of the same id is never touched.
5. **Session marker repair** — stored `endeavour/plan` and `endeavour/peer` rows
   gain the `ignorable` marker that keeps them readable without the plugin. This
   rewrites session logs, so it is skipped while DSH Desktop runs (the installer
   says so) and applies on the next run with the app quit; the plugin's own
   runtime admission keeps those sessions readable in the meantime.

Re-running install is idempotent.

### Manual restart versus scheduled restart

Restarting by hand is always safe. When an agent has to restart the app it must schedule it instead of
performing it inside the same call, because quitting DSH Desktop kills the host that owns that call:
DSH records the call as interrupted with an unknown outcome and any pending report is never delivered.

```
node "$HOME/.dsh/profiles/desktop/node_modules/dsh-orbital-agents/scripts/schedule-desktop-restart.mjs" --delay-seconds 45
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

Restart behavior: profile bundle rows, including the two preset rows this
package declares, are mounted at startup, so restart the app after install or
update. Already-running sessions keep their existing scope.

## 4. Peer presets

Both presets ship inside the package as bundle patches: `cordis.patch.yml`
inserts the `endeavour` host row, `presets/endeavour.patch.yml` declares the
Endeavour preset and `presets/challenger.patch.yml` the Challenger preset, each
as one `@deepseek-ai/dsh-agent-preset` row. Endeavour mounts the planner catalog
(`endeavour_plan`, `endeavour_verify`); Challenger mounts the executor catalog
(`challenger_start_task`, `challenger_report`) and keeps the full coding tool
surface with no delegation or ordinary messaging tools. Both scoped tool rows
resolve through the package specifier `dsh-orbital-agents/tools`.

Uninstall retires any ownership-marked preset directory an earlier release left
behind; rollback restores the exact prior directory state.

`preset-check` validates both personas, both role mounts, the coding rows, the
generated patches, and the absence of subagent/delegation mounts.

## 5. Upgrading from the predecessor package

Earlier releases shipped as `dsh-endeavour`. The installer treats that name as a known, owned
predecessor and migrates it in one run, without touching anything it does not own:

1. removes the predecessor package from the profile (`pnpm remove dsh-endeavour`);
2. rewrites its `dsh.profile.bundles` row to `dsh-orbital-agents` **in place**, so the row is never
   duplicated and unrelated bundles keep their order;
3. installs `dsh-orbital-agents` and retires the ownership-marked preset directories the predecessor
   installed, including the `node_modules/dsh-orbital-agents` link inside them;
4. leaves every other bundle, package and user-authored preset exactly as it was.

The `.dsh-endeavour-owned` marker keeps working as the ownership marker, so preset directories
installed by the predecessor are still recognised as ours (and are still never confused with a user's
own preset).
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
# remove plugin, bundle row, and only the preset directories this package owns
node scripts/install-local.mjs --uninstall

# list backups, then restore profile files + preset state exactly
node scripts/install-local.mjs --list-backups
node scripts/install-local.mjs --rollback <timestamp>
```

Ownership rules: uninstall removes a preset directory under
`~/.dsh/.agent-presets` only when it carries `.dsh-endeavour-owned`; a
user-authored preset is never deleted. Rollback restores the backed-up profile
files and the exact prior preset state
(including "no preset existed before" by removing the owned one). If anything
fails mid-install, the installer rolls partial profile/preset changes back
automatically.

Never disable Gatekeeper, remove quarantine flags, edit the app bundle, or use
sudo for any of these operations.
