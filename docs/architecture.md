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
- Mutations are serialized per root. Each one validates role (Endeavour vs Challenger),
  sequence, active plan, exact child–parent lineage (`plan.childId` under
  `plan.rootSessionId`), and the legal transition before appending.

## State machine

```
waiting --challenger_start_task--> running --challenger_report--> running (checking)
running (checking) --endeavour_verify succeeded--> succeeded
running (checking) --endeavour_verify failed--> failed, plan terminal
last task succeeded -> plan terminal completed
```

- A task starts only through the Challenger's explicit `challenger_start_task`.
- The public row stays running while Endeavour checks; the internal "checking"
  flag is exposed as a card hint, never as a fifth status.
- Duration freezes at the Challenger report (`finishedAt = reportedAt`) for both
  Finished and Confirmed rows, so the number a reader sees never changes once the
  task is reported; a task that is still running ticks live. The card computes
  live elapsed locally from durable timestamps; the plugin stores no per-second
  events.
- Duplicate starts, duplicate reports, out-of-order tasks, foreign sessions,
  arbitrary parent ids, and second plans are rejected with typed errors.

## Peer presets and role catalogs

- Two owned presets ship together: `endeavour` (planner) and `challenger`
  (executor). Each mounts the package tools row with an explicit `role`, so a
  preset's agent sees exactly its catalog: `endeavour_plan`/`endeavour_verify`
  for the planner, `challenger_start_task`/`challenger_report` for the executor.
  Standard mounts no row and sees none.
- The installer links `node_modules/dsh-orbital-agents` into BOTH preset directories
  because the relative tools row resolves from the composition directory.
- The service no longer creates subagents: `SubagentHost`, `startContinuable`,
  `sendMessage` and `SubagentAddress` are removed from active code, and the
  global plugin injects only `sessions`, `sessionProjections` and
  `sessionController`.
- The composer's model UI is the unified control described under
  [Configuration](configuration.md): one entry (`endeuvre-models`) that serves
  both roles.

## Two-phase protocol

- Execution: the Challenger receives the WHOLE plan with the first plan-ready relay and runs it
  sequentially. After each task it appends a durable `task-reported` checkpoint
  (persisted status stays `running`; the display stage becomes Finished).
  Intermediate successful reports send ZERO parent messages and the next task
  is started directly by the Challenger.
- Review: only when every task has a report does the service send exactly ONE
  aggregate parent message listing the ordered report evidence and asking
  Endeavour to verify each item. `endeavour_verify` records one ordered verdict
  per task, sends nothing to the child and never dispatches. A plan completes
  only after the last success verdict; the first failed verdict finalizes it as
  failed.
- Exception: a report with a blocker/failure sends that single review request
  immediately and stops progression; later tasks stay waiting.
- N reports -> 1 notification -> N verdicts. Finished means "Challenger reported",
  Confirmed means "Endeavour verified"; a task's duration freezes at its report
  time through confirmation.

## Blank-peer navigation (rc.2 limitation)

A freshly provisioned Challenger has no turns yet, and the native conversation
chrome renders only once a session has content: rc.2 registers the Chat View
lazily inside the (hidden) View ring and republishes the conversation snapshot
only when the assembly is dirty, so activating the Chat target for a
message-less session cannot surface the native `Chat/Trajectory/Endeavour` strip.
No synthetic turn, `beginSubmission` misuse or fabricated event is used to work
around this.

Navigation therefore uses two official surfaces, both `ISessions.open` bridges:

- the **role-aware plan action** (transcript card and composer dock): the
  Endeavour side opens its persistent Challenger, the Challenger side opens the
  paired Endeavour root, and a historical `childId`-only card stays a disabled
  history affordance;
- the **blank-peer return fallback** in `conversation.input.dock`, rendered only
  while the current session is the paired Challenger AND no plan is projected,
  so a blank peer still has a visible `Endeavour` return button. As soon as a
  plan is projected the shared dock's `Open Endeavour` action takes over and the
  fallback disappears, keeping exactly one return affordance.

Once the Challenger carries protocol content (a plan, a report or any turn), the
native View ring renders normally and its `Endeavour` tab is the primary return
path; the fallback then stays hidden.

## Pair identity and policy

- `pairCodeFor(pairId)` derives six unambiguous uppercase characters with
  SHA-256, so the code is stable across restarts/HMR and both members compute the
  same value; `[CODE] Endeavour` / `[CODE] Challenger` titles are applied through
  the official session-title service (root titles preserved and prefixed, older
  codes replaced).
- The Challenger always runs `danger-full-access` (unrestricted host filesystem
  and process access, no approvals), enforced through the official
  permission-preset service on create/adopt/repair and re-asserted before every
  `plan-ready` delivery; failure keeps the outbox pending and returns a typed
  error instead of starting execution. The Endeavour side keeps its own preset.

## Historical compatibility: the legacy Builder child

> Historical note only. Plans created before the persistent peer runtime used a
> continuable Builder child. Those terminal plans stay readable through the
> `childId` fallback (`isLegacyChildPlan`), their mutation paths are rejected,
> and new plans never create a child. Nothing below describes current behavior.

- Retired: `endeavour_plan` used to create one continuable Builder child per
  plan and every dispatch reused it through `sendMessage`.
- Retired: a later plan created a new child with a freshly snapshotted Builder
  route.
- Retired: the composer `Builder` tab and the dock's addressed
  `sessions.openSubagent({parentSessionId, childSessionId, mode:'continuable'})`
  navigation opened that child; those controls are gone and the peer navigation
  tab described above replaces them.
- Older children, where they still exist, remain reachable through the native
  Subagents surface.

## Client

- One `ConversationNodeDefinition` folds the durable event family with
  `target: 'chat'` and a keyed `conversation.chat.node` renderer.
- The card renders only short titles, the four statuses, progress, the current
  task, a live mm:ss timer, the frozen duration, a short check note, and the
  role-aware navigation action (`Open Challenger` on the Endeavour side, `Open
  Endeavour` on the peer side). Detailed instructions never enter the card
  payload.
- Status glyphs: gray ring Waiting, animated business-blue ring Working, the
  shared check-ring in green while Finished (reported, not yet accepted), the
  same check-ring in the host's violet-400 accent once Confirmed
  (`rgb(167, 139, 250)`, the ContextMeter `--meter-tint` precedent, since DSH
  publishes no purple semantic token), and a red cross on failure.
- Live Challenger activity adds one EPHEMERAL mark, never a durable status: when
  the paired Challenger session is not running (`SessionListState.ready` with a
  missing row or `running !== true`) while the plan is still in execution before
  review, the current unreported row shows `Challenger stopped` with a static
  warn-orange circled exclamation. It is derived in the client from the official
  `useSessions` snapshot plus two renderer-only card facts (the current
  unreported task id and whether the `plan-ready` relay was delivered), it never
  writes plan state or session events, it is suppressed while the list is still
  pending, before delivery, during review and after a terminal outcome, and it
  clears reactively when the Challenger runs again.
- The definition matches only `endeavour/plan` events, which exist only in the
  Lead/root session, so the card cannot render in the Challenger chat.
