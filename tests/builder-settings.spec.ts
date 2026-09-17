/** Builder route settings, resolution, durability, and projection regressions. */

import { describe, expect, it } from 'vitest'
import {
  defaultBuilderSettings,
  snapshotBuilderSettings,
  validateBuilderSettings,
  type BuilderRouteSettings,
} from '../src/builder-settings.js'
import { projectPlanCard } from '../src/plan-projection.js'
import { createPlanState, PlanId, TaskId, type TaskSpec } from '../src/domain.js'
import { registerEndeavourProjection } from '../src/projection-host.js'
import { EndeavourService } from '../src/service.js'

function spec(id: string): TaskSpec {
  return { id: TaskId(id), display: { title: id }, execution: { instructions: `${id} do`, validation: `${id} check` } }
}

describe('builder settings shape', () => {
  it('defaults to inherit without a composition base and to custom with one', () => {
    expect(defaultBuilderSettings({})).toEqual({ mode: 'inherit' })
    expect(defaultBuilderSettings({ provider: 'p', model: 'm' })).toEqual({ mode: 'custom', provider: 'p', model: 'm' })
    expect(defaultBuilderSettings({ provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 4096 }))
      .toEqual({ mode: 'custom', provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 4096 })
  })

  it('validates cross-field rules', () => {
    expect(validateBuilderSettings({ mode: 'inherit' })).toEqual([])
    expect(validateBuilderSettings({ mode: 'inherit', provider: 'p' })).toContain('provider is not allowed in inherit mode')
    expect(validateBuilderSettings({ mode: 'custom', model: 'm' })).toContain('custom mode requires a provider')
    expect(validateBuilderSettings({ mode: 'custom', provider: 'p' })).toContain('custom mode requires a model')
    expect(validateBuilderSettings({ mode: 'custom', provider: 'p', model: 'm' })).toEqual([])
    expect(validateBuilderSettings({ mode: 'custom', provider: 'p', model: 'm', reasoningEffort: ' ' })).toContain('reasoningEffort must be non-empty when present')
    expect(validateBuilderSettings({ mode: 'custom', provider: 'p', model: 'm', maxTokens: 0 })).toContain('maxTokens must be a positive integer')
  })

  it('snapshots settings defensively', () => {
    const source: BuilderRouteSettings = { mode: 'custom', provider: 'p', model: 'm' }
    const copy = snapshotBuilderSettings(source)
    source.model = 'changed'
    expect(copy.model).toBe('m')
  })
})

function fakeSession(id: string) {
  const events: { type: string; data: unknown }[] = []
  const session = {
    id,
    seq: 0,
    eventAt(seq: number) { return events[seq] },
    append(type: string, data: unknown) { events.push({ type, data }); session.seq += 1 },
    events,
  }
  return session
}

function fakeContext(root: ReturnType<typeof fakeSession>) {
  const starts: { request: { agentOptions?: unknown } }[] = []
  const ctx = {
    reflect: { provide: () => () => undefined },
    sessions: { get: (id: string) => (id === root.id ? root : undefined), flush: async () => true, list: () => [root] },
    subagents: {
      startContinuable: async (spec: unknown) => { starts.push(spec as { request: { agentOptions?: unknown } }); return { childId: 'child', messageId: 'm' } },
      sendMessage: async () => undefined,
    },
  }
  return { ctx: ctx as never, starts }
}

const parentAgent = {
  id: 'root',
  options: { provider: 'planner-p', model: 'planner-m', reasoningEffort: 'planner-effort', maxTokens: 1000 },
  session: { id: 'root', requestHeader: () => ({ provider: 'planner-p', model: 'planner-m', reasoningEffort: 'planner-effort' }) },
}

describe('service route resolution', () => {
  async function createWith(settings: BuilderRouteSettings) {
    const root = fakeSession('root')
    const { ctx, starts } = fakeContext(root)
    const service = new EndeavourService(ctx)
    let current = settings
    service.setBuilderSettingsSource(() => current)
    const created = await service.createPlan(parentAgent as never, { title: 'Plan', brief: 'brief', tasks: [spec('t1')] })
    const plan = service.getPlanByChild('child')
    return { service, starts, created, plan, setSettings: (next: BuilderRouteSettings) => { current = next } }
  }

  it('inherit mode passes the Planner route through the public delegation helper', async () => {
    const { starts, plan } = await createWith({ mode: 'inherit' })
    expect(starts[0]?.request.agentOptions).toMatchObject({ provider: 'planner-p', model: 'planner-m', reasoningEffort: 'planner-effort', maxTokens: 1000 })
    expect(plan?.builderRoute).toEqual({ provider: 'planner-p', model: 'planner-m', reasoningEffort: 'planner-effort', inherited: true })
  })

  it('custom mode pins provider/model and never carries the parent effort', async () => {
    const { starts, plan } = await createWith({ mode: 'custom', provider: 'cheap', model: 'small' })
    expect(starts[0]?.request.agentOptions).toEqual({ provider: 'cheap', model: 'small' })
    expect(plan?.builderRoute).toEqual({ provider: 'cheap', model: 'small', inherited: false })
  })

  it('custom mode carries an explicit effort and maxTokens', async () => {
    const { starts, plan } = await createWith({ mode: 'custom', provider: 'cheap', model: 'small', reasoningEffort: 'low', maxTokens: 2048 })
    expect(starts[0]?.request.agentOptions).toEqual({ provider: 'cheap', model: 'small', reasoningEffort: 'low', maxTokens: 2048 })
    expect(plan?.builderRoute?.reasoningEffort).toBe('low')
  })

  it('changing the setting after spawn does not change the spawned plan route', async () => {
    const { setSettings, plan, service } = await createWith({ mode: 'custom', provider: 'cheap', model: 'small' })
    setSettings({ mode: 'custom', provider: 'other', model: 'large' })
    expect(service.getPlanByChild('child')?.builderRoute).toEqual(plan?.builderRoute)
    expect(plan?.builderRoute?.provider).toBe('cheap')
  })

  it('invalid settings fall back to inherit safely', async () => {
    const { starts, plan } = await createWith({ mode: 'custom', provider: 'cheap' })
    expect(starts[0]?.request.agentOptions).toMatchObject({ provider: 'planner-p', model: 'planner-m' })
    expect(plan?.builderRoute?.inherited).toBe(true)
  })
})

describe('durable route projection', () => {
  it('exposes the route on the card and registers stateVersion 3 with the route in the wire schema', () => {
    const plan = createPlanState({
      planId: PlanId('p1'), rootSessionId: 'root', childId: 'child', title: 'Plan',
      tasks: [spec('t1')], at: 0,
      builderRoute: { provider: 'cheap', model: 'small', reasoningEffort: 'low', inherited: false },
    })
    const card = projectPlanCard(plan)
    expect(card.builderRoute).toEqual({ provider: 'cheap', model: 'small', reasoningEffort: 'low', inherited: false })

    let definition: { stateVersion: number; wire?: { viewSchema?: { parse(value: unknown): unknown } } } | undefined
    registerEndeavourProjection({ sessionProjections: { register: (value: never) => { definition = value as never; return () => {} } } } as never)
    expect(definition?.stateVersion).toBe(3)
    expect(() => definition?.wire?.viewSchema?.parse(card)).not.toThrow()
    // Old replay without the route stays valid.
    expect(() => definition?.wire?.viewSchema?.parse({ ...card, builderRoute: undefined })).not.toThrow()
  })
})
