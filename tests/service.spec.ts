import { describe, expect, it } from 'vitest'
import { EndeavourError } from '../src/domain.js'
import { EndeavourService, type EndeavourConfig } from '../src/service.js'

interface FakeEvent { type: string; data: unknown }

function fakeSession(id: string) {
  const events: FakeEvent[] = []
  const session = {
    id,
    seq: 0,
    eventAt(seq: number) { return events[seq] },
    append(type: string, data: unknown) { events.push({ type, data }); session.seq += 1 },
    events,
  }
  return session
}

function fakeContext(sessions: ReturnType<typeof fakeSession>[]) {
  const sent: { sender: unknown; target: string; text: string }[] = []
  const starts: unknown[] = []
  const ctx = {
    reflect: { provide: () => () => undefined },
    sessions: {
      get: (id: string) => sessions.find((session) => session.id === id),
      flush: async () => undefined,
      list: () => sessions,
    },
    subagents: {
      startContinuable: async (spec: unknown) => { starts.push(spec); return { childId: 'child', messageId: 'm1' } },
      sendMessage: async (sender: unknown, target: string, content: { text?: string }[], _options: unknown) => {
        sent.push({ sender, target, text: content.map((block) => block.text ?? '').join('\n') })
      },
    },
  }
  return { ctx: ctx as never, sent, starts }
}

const rootAgent = { id: 'root' }
const childAgent = { id: 'child', parentSessionId: 'root', session: { id: 'child', parentId: 'root' } }

function planInput() {
  return {
    title: 'План',
    brief: 'brief',
    tasks: [
      {
        id: 't1' as never,
        display: { title: 'Первый' },
        execution: { instructions: 'do t1', validation: 'check t1' },
      },
      {
        id: 't2' as never,
        display: { title: 'Второй' },
        execution: { instructions: 'do t2', validation: 'check t2' },
      },
    ],
  }
}

function makeService(config: EndeavourConfig = {}) {
  const root = fakeSession('root')
  const child = fakeSession('child')
  const { ctx, sent, starts } = fakeContext([root, child])
  const service = new EndeavourService(ctx, config)
  return { service, root, child, sent, starts }
}

describe('EndeavourService', () => {
  it('creates one active plan, spawns one Builder child, and rejects a second plan', async () => {
    const { service, starts, root } = makeService()
    const created = await service.createPlan(rootAgent as never, planInput())
    expect(created.taskCount).toBe(2)
    expect(starts).toHaveLength(1)
    expect(root.events.map((event) => event.type)).toEqual(['endeavour/plan'])
    await expect(service.createPlan(rootAgent as never, planInput())).rejects.toBeInstanceOf(EndeavourError)
  })

  it('rejects root sessions trying Builder operations and children trying verification', async () => {
    const { service } = makeService()
    const created = await service.createPlan(rootAgent as never, planInput())
    await expect(service.builderStartTask(rootAgent as never, 't1')).rejects.toBeInstanceOf(EndeavourError)
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' })
    await expect(service.verifyTask(childAgent as never, 't1', 'succeeded')).rejects.toBeInstanceOf(EndeavourError)
    expect(created.childId).toBe('child')
  })

  it('wakes the exact direct parent with a compact verification request', async () => {
    const { service, sent } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 'готово', files: ['a.ts'], validation: 'ok' })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target).toBe('root')
    expect(sent[0]?.text).toContain('Первый')
    expect(sent[0]?.text).toContain('endeavour_verify')
  })

  it('dispatches the next detailed task only after a succeeded verdict', async () => {
    const { service, sent, starts } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' })
    await service.verifyTask(rootAgent as never, 't1', 'succeeded')
    expect(sent).toHaveLength(2)
    expect(sent[1]?.target).toBe('child')
    expect(sent[1]?.text).toContain('do t2')
    expect(starts).toHaveLength(1)
  })

  it('rejects out-of-order and duplicate reports, and stops on failure', async () => {
    const { service, sent, root } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await expect(service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' }))
      .rejects.toBeInstanceOf(EndeavourError)
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' })
    await expect(service.builderReport(childAgent as never, 't1', { summary: 'x', files: [], validation: 'v' }))
      .rejects.toBeInstanceOf(EndeavourError)
    await service.verifyTask(rootAgent as never, 't1', 'failed', 'Не прошло')
    const plan = service.getActivePlan('root')
    expect(plan).toBeUndefined()
    expect(sent).toHaveLength(1)
    expect(root.events).toHaveLength(4)
  })

  it('recovers durable plans from replayed root events', () => {
    const root = fakeSession('root')
    const { ctx } = fakeContext([root])
    const before = new EndeavourService(ctx)
    expect(before.getActivePlan('root')).toBeUndefined()
  })
})
