/**
 * Protocol copy contract: no stale dispatch/wait language anywhere the model or
 * the installer can see, and the canonical two-phase wording is present.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

const stalePatterns = [
  /next task is dispatched/i,
  /dispatched automatically/i,
  /wait for Endeavour'?s verification/i,
  /On success, the next task/i,
]

describe('two-phase copy', () => {
  const files = [
    'src/prompts/builder.md',
    'src/prompts/endeavour.md',
    'preset/endeavour/agent.cordis.yml',
    'preset/endeavour/preset.yml',
    'src/tools.ts',
    'README.md',
    'docs/architecture.md',
    'docs/configuration.md',
    'docs/install.md',
  ]

  it('contains no stale dispatch/wait instructions', () => {
    for (const file of files) {
      const text = read(file)
      for (const pattern of stalePatterns) {
        expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern)
      }
    }
  })

  it('keeps the canonical Builder contract', () => {
    const builder = read('src/prompts/builder.md')
    expect(builder).toMatch(/receive the WHOLE plan/i)
    expect(builder).toMatch(/continue directly with the next task/i)
    expect(builder).toMatch(/one aggregate review request/i)
    // The Builder persona must never tell the model to use ordinary messaging.
    expect(builder).not.toMatch(/send_message/)
  })

  it('keeps the canonical Endeavour contract', () => {
    const endeavour = read('src/prompts/endeavour.md')
    expect(endeavour).toMatch(/Wait for the single aggregate review request/i)
    expect(endeavour).toMatch(/never dispatch the next task/i)
    expect(endeavour).toMatch(/one verdict per\s+task in plan order/i)
  })

  it('documents N reports -> 1 notification -> N verdicts and the tool copy', () => {
    const docs = read('docs/architecture.md')
    expect(docs).toMatch(/N reports -> 1 notification -> N verdicts/)
    const tools = read('src/tools.ts')
    expect(tools).toMatch(/marks the task Finished/i)
    expect(tools).toMatch(/never dispatches work/i)
    // The embedded preset persona is generated from the source prompt.
    const preset = read('preset/endeavour/agent.cordis.yml')
    expect(preset).toContain('Wait for the single aggregate review request')
  })
})
