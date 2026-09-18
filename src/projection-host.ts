/**
 * Host session projection for the durable Endeavour plan.
 *
 * The `endeavourPlan` key folds the whole-value `endeavour/plan` checkpoints
 * into the latest card payload and publishes it through the session
 * projection wire, so the composer dock renders the current durable plan even
 * when the plan events are older than the client's paged transcript window.
 */

import type { Context } from '@deepseek-ai/cordis'
import { z as zod, type ZodType } from 'zod'
// Type-only: resolves the ctx.sessionProjections service declaration.
import type {} from '@deepseek-ai/dsh-session-projection'
import { projectPeerState } from './peer-projection.js'
import type { PeerState } from './peer.js'
import { projectPlanCard, type EndeavourCardData } from './plan-projection.js'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Latest durable Endeavour plan card, or null before the first plan. */
    endeavourPlan: EndeavourCardData | null
    /** Latest durable peer pair for this session, or null when unpaired. */
    endeavourPeer: PeerState | null
  }
  interface SessionProjectionMap {
    /** Latest durable Endeavour plan card, or null before the first plan. */
    endeavourPlan: EndeavourCardData | null
    /** Latest durable peer pair for this session, or null when unpaired. */
    endeavourPeer: PeerState | null
  }
}

const taskSchema = zod.object({
  id: zod.string(),
  title: zod.string(),
  status: zod.union([zod.literal('waiting'), zod.literal('running'), zod.literal('succeeded'), zod.literal('failed')]),
  stage: zod.union([
    zod.literal('waiting'), zod.literal('working'), zod.literal('finished'), zod.literal('confirmed'), zod.literal('failed'),
  ]),
  startedAt: zod.number().optional(),
  finishedAt: zod.number().optional(),
  reportedAt: zod.number().optional(),
  note: zod.string().optional(),
})

const cardSchema: ZodType<EndeavourCardData | null> = zod.union([
  zod.object({
    planId: zod.string(),
    rootSessionId: zod.string(),
    title: zod.string(),
    tasks: zod.array(taskSchema),
    completedCount: zod.number(),
    total: zod.number(),
    currentTitle: zod.string().optional(),
    checking: zod.boolean(),
    terminal: zod.object({
      outcome: zod.union([zod.literal('completed'), zod.literal('failed')]),
      at: zod.number(),
      note: zod.string().optional(),
    }).optional(),
    childId: zod.string(),
    builderRoute: zod.object({
      provider: zod.string(),
      model: zod.string(),
      reasoningEffort: zod.string().optional(),
      inherited: zod.boolean(),
    }).optional(),
  }),
  zod.null(),
]) as ZodType<EndeavourCardData | null>

/** Durable peer-pair view: the same validated state for both members. */
const peerSchema: ZodType<PeerState | null> = zod.union([
  zod.object({
    version: zod.literal(1),
    pairId: zod.string(),
    endeavourSessionId: zod.string(),
    challengerSessionId: zod.string(),
    createdAt: zod.number(),
    updatedAt: zod.number(),
    sequence: zod.number(),
  }),
  zod.null(),
]) as ZodType<PeerState | null>

/**
 * Register the `endeavourPeer` projection on the global plugin's context.
 * stateVersion 1 carries the whole validated pair checkpoint; each member
 * derives its own role/counterpart with `peerView`.
 */
export function registerEndeavourPeerProjection(ctx: Context): void {
  ctx.sessionProjections.register<'endeavourPeer', PeerState | null>({
    key: 'endeavourPeer',
    stateSchema: peerSchema,
    init: () => null,
    apply: (state, event) => {
      if (event.type === 'endeavour/peer') return projectPeerState(event.data.plan)
      return state
    },
    wire: { viewSchema: peerSchema, view: (state) => state },
    stateVersion: 1,
  })
}

/**
 * Register the `endeavourPlan` projection on the global plugin's context.
 * stateVersion 3 adds `builderRoute` (the exact durable route), on top of
 * stateVersion 2's `rootSessionId` and derived `stage`/`reportedAt` fields.
 */
export function registerEndeavourProjection(ctx: Context): void {
  ctx.sessionProjections.register<'endeavourPlan', EndeavourCardData | null>({
    key: 'endeavourPlan',
    stateSchema: cardSchema,
    init: () => null,
    apply: (state, event) => {
      // Whole-value checkpoint: the newest event already carries complete state.
      if (event.type === 'endeavour/plan') return projectPlanCard(event.data.plan)
      return state
    },
    wire: { viewSchema: cardSchema, view: (state) => state },
    stateVersion: 3,
  })
}
