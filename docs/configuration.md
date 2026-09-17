# Builder model configuration

The package/preset config exposes optional Builder routing. All fields are
optional and live on the `endeavour` row in the profile patch:

```yaml
- insert:
    - id: endeavour
      name: dsh-endeavour
      config:
        builderProvider: spawn
        builderAgentOptions:
          provider: <provider-id>
          model: <model-id>
          reasoningEffort: <effort-id>
          maxTokens: 32000
        maxDepth: 1
```

- `builderProvider` defaults to `spawn`, the in-process continuable provider
  used by the stable family.
- `builderAgentOptions` is passed to `ctx.subagents.startContinuable` as
  `agentOptions`. When unset, the Builder child inherits the Endeavour chat's
  own model route — safe, but it means both roles share one bill.
- Cost separation requires explicitly choosing a cheaper provider/model route.
- `builderPersona` defaults to the packaged Builder prompt
  (`lib/prompts/builder.md`); `builderToolFilter` defaults to the runtime's
  unrestricted set and can scope the child to Builder-safe tools.
