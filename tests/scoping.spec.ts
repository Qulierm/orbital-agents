/**
 * Scope regression tests: the global bundle must provide the durable service
 * without registering model-facing tools; the scoped plugin is the only place
 * the four orchestration tools are registered, and it cannot load without the
 * provided service (so the standard preset never sees them).
 */

import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/cordis', () => ({
  Service: class {
    ctx: unknown
    name: string
    constructor(ctx: unknown, name: string) {
      this.ctx = ctx
      this.name = name
    }
  },
}))

const { apply: applyGlobal, inject: globalInject } = await import('../src/index.js')
const { apply: applyTools, inject: toolsInject } = await import('../src/tools-plugin.js')

interface RegisteredTool {
  readonly name?: string
}

function toolContext() {
  const registered: RegisteredTool[] = []
  const ctx = {
    inject: () => undefined,
    tools: { register: (tool: RegisteredTool) => { registered.push(tool) } },
    // Valid-shaped host views so the service constructor's recovery scan is a no-op.
    sessions: { get: () => undefined, flush: async () => true, list: () => [] },
    sessionProjections: { register: () => () => undefined },
    subagents: { startContinuable: async () => ({ childId: 'child' }), sendMessage: async () => undefined },
  }
  return { ctx, registered }
}

describe('scope separation', () => {
  it('global bundle provides the service but registers no model tools', () => {
    const { ctx, registered } = toolContext()
    applyGlobal(ctx as never, {})
    expect(registered).toHaveLength(0)
    expect(globalInject).toEqual(['subagents', 'sessions', 'sessionProjections', 'sessionController'])
  })

  it('global bundle never calls the tool-registration seam', () => {
    const source = readFileSync('src/index.ts', 'utf8')
    expect(source).not.toContain('registerTools')
    expect(source).not.toContain("from './tools.js'")
  })

  it('scoped tools plugin registers exactly the configured role catalog', () => {
    expect(toolsInject).toEqual(['tools', 'endeavour'])
    const planner = toolContext()
    applyTools({ ...planner.ctx, endeavour: {} } as never)
    expect(planner.registered.map((tool) => tool.name).sort()).toEqual(['endeavour_plan', 'endeavour_verify'])

    const challenger = toolContext()
    applyTools({ ...challenger.ctx, endeavour: {} } as never, { role: 'challenger' })
    expect(challenger.registered.map((tool) => tool.name).sort()).toEqual(['challenger_report', 'challenger_start_task'])

    // No legacy builder_* schemas are exposed to any new catalog.
    for (const tool of [...planner.registered, ...challenger.registered]) {
      expect(String(tool.name)).not.toMatch(/^builder_/)
    }
    // An unknown role fails closed instead of mounting something unspecified.
    expect(() => applyTools({ ...toolContext().ctx, endeavour: {} } as never, { role: 'standard' } as never))
      .toThrow(/unknown role/)
  })

  it('a standard scope cannot satisfy the tools plugin dependencies', () => {
    // Cordis resolves `inject`; without a provider for 'endeavour' the plugin
    // never mounts, so the standard preset has no Endeavour tools. The global
    // bundle is the only provider of that name.
    expect(toolsInject).toContain('endeavour')
    const globalSource = readFileSync('src/index.ts', 'utf8')
    expect(globalSource).toContain('new EndeavourService(ctx, config)')
    const serviceSource = readFileSync('src/service.ts', 'utf8')
    expect(serviceSource).toContain("super(ctx, 'endeavour')")
  })
})
