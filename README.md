# dsh-endeavour

Standalone DSH plugin: one durable Endeavour plan, one continuable Builder
child, and a replayable plan card inside the Endeavour Chat.

- Target runtime: DeepSeek Harness **v0.1.5-rc.2** (Cordis 4.0.2), the family
  bundled by the third-party community **DSH Desktop v2.0.11**. This is a
  community integration; it is not an official DeepSeek product.
- One active plan per Endeavour session, one Builder child, sequential tasks.
- User-visible task states are exactly four: waiting, running, succeeded,
  failed — rendered as "Ожидает начала", "Выполняется", "Выполнился успешно",
  "Не выполнился".
- Verification is a quick acceptance check; only Endeavour records success or
  failure, and the Builder can never authorize terminal success.

See [docs/install.md](docs/install.md) for setup, install, uninstall and
rollback, and [docs/configuration.md](docs/configuration.md) for Builder model
configuration. The architecture and invariants are described in
[docs/architecture.md](docs/architecture.md).
