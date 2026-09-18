# Architecture and invariants

## Orchestration

- One durable plan per Endeavour root session, executed by its persistent
  ordinary **Challenger** peer (one logical session = two ordinary sessions:
  Endeavour + Challenger), sequential tasks, no worktrees or parallel work.
- A plan is delivered ONCE to the Challenger with the whole-plan brief through
  the typed peer transport (`plan-ready`); intermediate reports relay nothing
  and the final/blocker report sends exactly one ordered `review-ready`
  aggregate back to Endeavour.
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

## Peer presets and role catalogs

- Two owned presets ship together: `endeavour` (planner) and `challenger`
  (executor). Each mounts the package tools row with an explicit `role`, so a
  preset's agent sees exactly its catalog: `endeavour_plan`/`endeavour_verify`
  for the planner, `challenger_start_task`/`challenger_report` for the executor.
  Standard mounts no row and sees none.
- The installer links `node_modules/dsh-endeavour` into BOTH preset directories
  because the relative tools row resolves from the composition directory.
- The service no longer creates subagents: `SubagentHost`, `startContinuable`,
  `sendMessage` and `SubagentAddress` are removed from active code, and the
  global plugin injects only `sessions`, `sessionProjections` and
  `sessionController`.
- Remaining for the UI/model pass: the composer/dock still use the legacy
  `Builder` naming and the `endeavour-builder` route settings; the peer model
  control (Challenger-owned `modelSelection`) replaces them.

## Two-phase protocol

- Execution: the Builder receives the WHOLE plan at spawn and runs it
  sequentially. After each task it appends a durable `task-reported` checkpoint
  (persisted status stays `running`; the display stage becomes Finished).
  Intermediate successful reports send ZERO parent messages and the next task
  is started directly by the Builder.
- Review: only when every task has a report does the service send exactly ONE
  aggregate parent message listing the ordered report evidence and asking
  Endeavour to verify each item. `endeavour_verify` records one ordered verdict
  per task, sends nothing to the child and never dispatches. A plan completes
  only after the last success verdict; the first failed verdict finalizes it as
  failed.
- Exception: a report with a blocker/failure sends that single review request
  immediately and stops progression; later tasks stay waiting.
- N reports -> 1 notification -> N verdicts. Finished means "Builder reported",
  Confirmed means "Endeavour verified"; a task's duration freezes at its report
  time through confirmation.

## Legacy Builder child lifecycle (historical plans only)

> Historical note: plans created before the peer runtime used a continuable
> Builder child. Those terminal plans stay readable through the `childId`
> fallback; their mutation paths are rejected and new plans never create a
> child.

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
