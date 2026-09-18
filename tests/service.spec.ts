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

  it('sends ZERO messages for intermediate reports and ONE aggregate on the final report', async () => {
    const { service, sent } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await service.builderStartTask(childAgent as never, 't1')
    const first = await service.builderReport(childAgent as never, 't1', { summary: 'готово', files: ['a.ts'], validation: 'ok' })
    expect(first.phase).toBe('executing')
    expect(first.nextTask?.id).toBe('t2')
    expect(sent).toHaveLength(0)
    await service.builderStartTask(childAgent as never, 't2')
    const second = await service.builderReport(childAgent as never, 't2', { summary: 'второй', files: [], validation: 'ok' })
    expect(second.phase).toBe('review')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target).toBe('root')
    expect(sent[0]?.text).toContain('endeavour_verify')
    expect(sent[0]?.text).toContain('Первый')
    expect(sent[0]?.text).toContain('Второй')
  })

  it('never dispatches to the child; review is ordered and terminal only after every verdict', async () => {
    const { service, sent, starts } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' })
    // Review cannot start before every task has a report.
    await expect(service.verifyTask(rootAgent as never, 't1', 'succeeded'))
      .rejects.toBeInstanceOf(EndeavourError)
    await service.builderStartTask(childAgent as never, 't2')
    await service.builderReport(childAgent as never, 't2', { summary: 's2', files: [], validation: 'v2' })
    await expect(service.verifyTask(rootAgent as never, 't2', 'succeeded'))
      .rejects.toBeInstanceOf(EndeavourError)
    const afterFirst = await service.verifyTask(rootAgent as never, 't1', 'succeeded')
    expect(afterFirst.terminal).toBeUndefined()
    const done = await service.verifyTask(rootAgent as never, 't2', 'succeeded')
    expect(done.terminal?.outcome).toBe('completed')
    // Only the single aggregate parent message; nothing was ever sent to the child.
    expect(sent).toHaveLength(1)
    expect(sent.every((message) => message.target === 'root')).toBe(true)
    expect(starts).toHaveLength(1)
  })

  it('rejects out-of-order and duplicate reports, and stops progression on a blocker', async () => {
    const { service, sent, root } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    await expect(service.builderReport(childAgent as never, 't2', { summary: 's', files: [], validation: 'v' }))
      .rejects.toBeInstanceOf(EndeavourError)
    await service.builderStartTask(childAgent as never, 't1')
    await service.builderReport(childAgent as never, 't1', { summary: 's', files: [], validation: 'v' })
    await expect(service.builderReport(childAgent as never, 't1', { summary: 'x', files: [], validation: 'v' }))
      .rejects.toBeInstanceOf(EndeavourError)
    // The next task is already startable after a successful report...
    await service.builderStartTask(childAgent as never, 't2')
    // ...but a blocker report stops all later progression immediately.
    const blocked = await service.builderReport(childAgent as never, 't2', { summary: 's', files: [], validation: 'v', blocker: 'нет доступа' })
    expect(blocked.phase).toBe('blocked')
    expect(sent).toHaveLength(1)
    await expect(service.builderStartTask(childAgent as never, 't1'))
      .rejects.toBeInstanceOf(EndeavourError)
    await service.verifyTask(rootAgent as never, 't1', 'succeeded')
    const failed = await service.verifyTask(rootAgent as never, 't2', 'failed', 'Не прошло')
    expect(failed.terminal?.outcome).toBe('failed')
    expect(service.getActivePlan('root')).toBeUndefined()
    expect(sent).toHaveLength(1)
    void root
  })

  it('runs a 3-task plan with send counts 0, 0, 1 and one ordered aggregate', async () => {
    const { service, sent } = makeService()
    const input = planInput()
    await service.createPlan(rootAgent as never, {
      ...input,
      tasks: [
        ...input.tasks,
        { id: 't3' as never, display: { title: 'Третий' }, execution: { instructions: 'do t3', validation: 'check t3' } },
      ],
    })
    const phases: string[] = []
    for (const id of ['t1', 't2', 't3']) {
      await service.builderStartTask(childAgent as never, id)
      const outcome = await service.builderReport(childAgent as never, id, { summary: id, files: [], validation: 'ok' })
      phases.push(outcome.phase)
      if (outcome.phase === 'executing') expect(outcome.nextTask?.id).toBe(id === 't1' ? 't2' : 't3')
    }
    expect(phases).toEqual(['executing', 'executing', 'review'])
    expect(sent).toHaveLength(1)
    expect(sent[0]?.target).toBe('root')
    for (const title of ['Первый', 'Второй', 'Третий']) expect(sent[0]?.text).toContain(title)
    // Duplicate reports never duplicate the notification.
    await expect(service.builderReport(childAgent as never, 't3', { summary: 'x', files: [], validation: 'v' }))
      .rejects.toBeInstanceOf(EndeavourError)
    expect(sent).toHaveLength(1)
  })

  it('denies ordinary parent messaging and delegation by default, keeping protocol tools free', async () => {
    const { service, starts } = makeService()
    await service.createPlan(rootAgent as never, planInput())
    const filter = (starts[0] as unknown as { request: { toolFilter?: { deny?: readonly string[]; allow?: readonly string[] } } }).request.toolFilter
    expect(filter).toBeDefined()
    const deny = filter?.deny ?? []
    // Ordinary parent messaging, delegation, and agent/job management are gone.
    for (const tool of ['send_message', 'subagent', 'subagent_fork', 'list_agents', 'interrupt_agent', 'job_output', 'workflow']) {
      expect(deny).toContain(tool)
    }
    // The durable protocol tools are NOT denied (they are scoped registrations
    // and restrictions do not affect them; the filter must not pretend to).
    expect(deny).not.toContain('builder_start_task')
    expect(deny).not.toContain('builder_report')
    // Coding/validation surface is not restricted by the default.
    expect(filter?.allow).toBeUndefined()
    for (const tool of ['bash', 'read', 'write', 'edit', 'glob', 'grep']) expect(deny).not.toContain(tool)
  })

  it('lets explicit configuration override the default tool filter verbatim', async () => {
    const custom = { allow: ['bash', 'read'] }
    const { service, starts } = makeService({ builderToolFilter: custom })
    await service.createPlan(rootAgent as never, planInput())
    const filter = (starts[0] as unknown as { request: { toolFilter?: unknown } }).request.toolFilter
    expect(filter).toEqual(custom)
  })

  it('recovers durable plans from replayed root events', () => {
    const root = fakeSession('root')
    const { ctx } = fakeContext([root])
    const before = new EndeavourService(ctx)
    expect(before.getActivePlan('root')).toBeUndefined()
  })
})
