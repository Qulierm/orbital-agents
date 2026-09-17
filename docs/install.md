# Install, uninstall, rollback

Target: DSH Desktop v2.0.11 (community app, anywhere-labs) bundling DeepSeek
Harness v0.1.5-rc.2, with the `desktop` profile at `~/.dsh/profiles/desktop`.

## Safe install

1. Build and pack this repository:

   ```sh
   pnpm install --frozen-lockfile   # or pnpm install on first checkout
   pnpm run verify
   pnpm pack                        # produces dsh-endeavour-0.1.0.tgz
   ```

2. Run the installer, which backs up the profile first:

   ```sh
   node scripts/install-local.mjs --tarball dsh-endeavour-0.1.0.tgz
   ```

   The script:
   - copies `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
     `cordis.yml` and `cordis.patch.yml` from `~/.dsh/profiles/desktop` into
     `~/.dsh/backups/endeavour/<timestamp>/`;
   - installs the tarball with `pnpm add` inside the profile (no sudo);
   - appends `dsh-endeavour` to `dsh.profile.bundles` while preserving the
     existing bundle order.

3. Restart DSH Desktop if required. The plugin row and the client card load
   with the profile; existing plugins (`dsh-codex-connect`, `dsh-context`,
   `dsh-cost-meter`) stay configured.

## Uninstall

```sh
node scripts/install-local.mjs --uninstall
```

Removes `dsh-endeavour` from `dsh.profile.bundles` and uninstalls the package,
leaving the other plugins untouched.

## Rollback

```sh
node scripts/install-local.mjs --rollback <timestamp>
```

Restores the backed-up profile files from
`~/.dsh/backups/endeavour/<timestamp>/` and reinstalls profile dependencies.
If activation fails, roll back rather than editing security settings: never
disable Gatekeeper, never remove quarantine flags, and never modify the app
bundle.
