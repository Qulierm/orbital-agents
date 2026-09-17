# Builder model configuration

By default the Builder **inherits** the Planner route: the child Agent gets
the same provider/model as the Endeavour chat, so both roles share one bill.
`--show-builder` prints exactly that state:

```
Builder route: inherited (no separate provider/model configured; the Builder uses the Planner route)
```

Cost separation requires choosing a separate route explicitly. Nothing is
selected automatically and no secrets are stored.

## Configure

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs \
  --configure-builder --provider <provider-id> --model <model-id> \
  [--reasoning-effort <effort-id>] [--max-tokens <n>]
```

- `--provider` and `--model` are required and must be non-empty; an empty
  value aborts the command without changing anything.
- `--max-tokens` must be a positive integer when present.
- The command backs up the profile, then updates only the `endeavour` row of
  `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: endeavour
  name: dsh-endeavour
  config:
    builderAgentOptions:
      provider: <provider-id>
      model: <model-id>
      reasoningEffort: <effort-id>   # optional
      maxTokens: <n>                 # optional
```

The configuration survives re-install and rollback because it lives in the
profile patch, which the installer backs up and restores.

## Show and reset

```sh
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --show-builder
node /Users/nikita/Documents/Coding/dsh-endeavour/scripts/install-local.mjs --reset-builder
```

`--reset-builder` removes the row's config and returns the Builder to the
inherited Planner route.

## How it is applied

`builderAgentOptions` is passed to `ctx.subagents.startContinuable` as
`agentOptions` when the plan creates the single continuable Builder child, with
the packaged Builder persona (`lib/prompts/builder.md`) as its per-child
persona. The Planner model is still chosen normally in the Endeavour chat; this
setting only steers the child.
