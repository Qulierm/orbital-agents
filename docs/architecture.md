# Architecture and invariants

## Orchestration

- One durable plan per Endeavour root session, one continuable Builder child
  created through `ctx.subagents.startContinuable` with the `spawn` provider,
  sequential tasks, no worktrees or parallel work.
- The Builder child receives a per-child persona (the packaged Builder prompt)
  and optional `agentOptions` / `toolFilter` from config.
- Durable events (`endeavour/plan`) are appended to the root/Endeavour session
  log with `session.append` and flushed through `ctx.sessions.flush`. Every
  payload is a whole-value checkpoint: `{ kind, at, plan }` where `plan` is the
  complete `PlanState`, so tail replay only needs the newest event.
- Mutations are serialized per root. Each one validates role (root vs Builder),
  sequence, active plan, exact child–parent lineage (`plan.childId` under
  `plan.rootSessionId`), and the legal transition before appending.

## State machine

```
waiting --builder_start_task--> running --builder_report--> running (checking)
running (checking) --endeavour_verify succeeded--> succeeded
running (checking) --endeavour_verify failed--> failed, plan terminal
last task succeeded -> plan terminal completed
```

- A task starts only through the Builder's explicit `builder_start_task`.
- The public row stays running while Endeavour checks; the internal "checking"
  flag is exposed as a card hint, never as a fifth status.
- Duration is frozen at Endeavour verification (`finishedAt - startedAt`), so it
  covers the whole lifecycle including the quick check. The card computes live
  elapsed locally from durable timestamps; the plugin stores no per-second
  events.
- Duplicate starts, duplicate reports, out-of-order tasks, foreign sessions,
  arbitrary parent ids, and second plans are rejected with typed errors.

## Builder child lifecycle

- `endeavour_plan` creates exactly ONE continuable Builder child per plan.
- Every task dispatch reuses that child through `sendMessage`; the Builder
  prompt does not spawn per task.
- A LATER plan creates a NEW child with a freshly snapshotted Builder route —
  one child is never reused across plans (that would freeze routing forever and
  mix contexts).
- The composer `Builder` tab opens the CURRENT/latest projected child only, as
  pure navigation: it resets the root view to Chat first and calls the same
  addressed `sessions.openSubagent({parentSessionId, childSessionId,
  mode:'continuable'})` bridge as the dock's Open Builder. It never spawns,
  writes settings, or makes a model call, and it is registered only while the
  current session is an Endeavour root with a valid durable child address.
- Older children remain reachable through the native Subagents surface.
- The addressed plan child gets the reciprocal `Endeavour` tab (order 20): it
  validates its own continuable address AND the parent's durable plan, resets
  its own view to Chat, then opens the exact parent through official session
  navigation. Arbitrary subagents, Standard chats, missing parents, and corrupt
  projections hide both tabs.

## Builder route ownership

- Both composer role groups live in `conversation.input.right`: the Builder
  group at order 1000 and the Endeavour role label at 1001, after the native
  Speed (10) and limits (20) entries, so the toolbar reads
  `Speed -> limits -> [Builder | route] -> [Endeavour | native model] -> Send`
  while the native ModelSelect keeps rendering after the right list.
- The route preference is an official Host Settings section
  (`endeavour-builder`) owned by this plugin; the root composer control writes
  it and the service snapshots it once at `createPlan`.
- Custom mode pins provider/model plus optional effort/maxTokens and never
  carries the Planner's effort; inherit mode resolves the Planner route through
  the public upstream delegation helper. The exact resolved route is stored on
  the durable plan (`builderRoute`) and projected (stateVersion 3) so an active
  or terminal plan stays inspectable after the preference changes.
- A spawned Builder is immutable: later settings writes affect only future
  children.

## Client

- One `ConversationNodeDefinition` folds the durable event family with
  `target: 'chat'` and a keyed `conversation.chat.node` renderer.
- The card renders only short titles, the four statuses, progress, current
  task, live mm:ss timer, frozen terminal duration, a short check note, and
  the standard Open Builder navigation. Detailed instructions never enter the
  card payload.
- The definition matches only `endeavour/plan` events, which exist only in the
  Lead/root session, so the card cannot render in the Builder chat.
