# Pending Challenger selection locking

## Decision

Each pending-choice save and conditional removal takes a native exclusive Web Lock named by the exact origin- and root-scoped storage key. While holding that lock, the store rereads durable `localStorage`. It removes a choice only when the stored revision still matches the revision whose application completed. The v1 key and record format remain unchanged. If the browser does not expose Web Locks, the mutation fails closed; there is no unlocked fallback.

## Rationale

A storage event is a notification, not a compare-and-swap. Its payload can be stale by the time a tab handles it. Rereading under the lock lets updated tabs make save and removal decisions from durable state, so a completed application cannot delete a newer cooperating tab's choice.

## Alternatives

Trusting `storage` event payloads or guarding writes with an in-memory mutex does not coordinate separate documents. `localStorage` has no atomic compare-and-swap. One lock for every session would also serialize unrelated choices, so the lock name stays specific to one origin and root.

## Ownership

`src/client/challenger-selection-store.ts` owns the key, v1 record, revision comparison and locked storage mutations. `src/client/index.ts` supplies the browser's native `navigator.locks` provider. The selector applies choices through the validated Challenger directory. [Model configuration](../configuration.md#pending-selection-storage) owns the user-facing prerequisite and timing limits.

## Limits

The browser must expose `navigator.locks`, normally in a secure context. Reload every open DSH tab after an update so each runs the lock-enabled code. The lock coordinates only updated tabs on the same origin using the same key; older tabs and arbitrary `localStorage` writers do not participate. This does not promise atomicity against non-cooperating writers. A choice remains local to its browser origin and exact Endeavour root, and affects requests assembled after application—not a request already in progress.

## Verification

`tests/challenger-selection-store.spec.ts` and `tests/model-bridge.spec.ts` cover lock and revision behavior with deterministic barriers. `scripts/pending-selection-browser-smoke.mjs` exercises the real store in two same-origin Chromium documents with native Web Locks and verifies that an older revision cannot remove the newer durable choice.
