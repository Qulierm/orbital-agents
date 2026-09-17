/**
 * Real-Cordis service proxy regression.
 *
 * Cordis service tracing invokes public methods through a scoped proxy
 * receiver. Native JS `#private` fields brand-check the receiver and reject
 * that proxy ("Receiver must be an instance of class EndeavourService"), so
 * proxy-callable services must use TS private members instead. These tests use
 * an actual parent/scoped child `Context`, not a mocked one.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { EndeavourError } from '../src/domain.js'
import { EndeavourService } from '../src/service.js'

function proxiedService() {
  const root = new Context()
  const scoped = root.extend()
  new EndeavourService(scoped as never, {})
  return (scoped as unknown as { endeavour: EndeavourService }).endeavour
}

describe('Cordis service proxy receiver', () => {
  it('serves a side-effect-free public method through the scoped proxy', () => {
    const service = proxiedService()
    expect(service.getActivePlan('some-session')).toBeUndefined()
  })

  it('reaches maps, queues and the config path through the proxy in createPlan', async () => {
    const service = proxiedService()
    const agent = { session: { id: 'root-session' } }
    const tasks = [{
      id: 't1' as never,
      display: { title: 'Первый шаг' },
      execution: { instructions: 'do it', validation: 'checked' },
    }]
    // Without host services the call must fail as a typed EndeavourError after
    // traversing the per-root queue and plan maps — never a receiver TypeError.
    await expect(service.createPlan(agent as never, { title: 'План', brief: 'brief', tasks }))
      .rejects.toBeInstanceOf(EndeavourError)
  })

  it('reaches the Builder path through the proxy in builderStartTask', async () => {
    const service = proxiedService()
    const child = { session: { id: 'child-session' } }
    await expect(service.builderStartTask(child as never, 't1'))
      .rejects.toBeInstanceOf(EndeavourError)
  })
})
