/** Preset contract tests: version-pinned base, persona drift, scoped tools row. */

import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { checkPreset, loadRows, STANDARD_PRESET_PATH, TOOLS_ROW_NAME } from '../scripts/preset-check.ts'

describe('Endeavour preset', () => {
  it('passes every contract and drift check', () => {
    expect(checkPreset()).toEqual([])
  })

  it('embeds the planner persona verbatim and keeps the cwd suffix', () => {
    const rows = loadRows('preset/endeavour/agent.cordis.yml') as {
      id?: string
      config?: { prefix?: string; suffix?: string }
    }[]
    const persona = rows.find((row) => row.id === 'persona')
    expect(persona?.config?.prefix).toBe(readFileSync('src/prompts/endeavour.md', 'utf8'))
    expect(persona?.config?.suffix).toContain('{{cwd}}')
  })

  it('retains the full standard composition plus the scoped tools row', () => {
    const ours = loadRows('preset/endeavour/agent.cordis.yml') as { id?: string; name?: string }[]
    const standard = loadRows(STANDARD_PRESET_PATH) as { id?: string; name?: string }[]
    for (const row of standard) {
      expect(ours.some((candidate) => candidate.id === row.id && candidate.name === row.name)).toBe(true)
    }
    expect(ours.filter((row) => row.name === TOOLS_ROW_NAME)).toHaveLength(1)
    expect(ours.length).toBe(standard.length + 1)
  })

  it('publishes user-readable metadata and leaves the standard preset untouched', () => {
    const metadata = load(readFileSync('preset/endeavour/preset.yml', 'utf8')) as {
      name?: string
      description?: string
      order?: number
    }
    expect(metadata.name).toBe('Endeavour')
    expect((metadata.description ?? '').length).toBeGreaterThan(10)
    expect(metadata.order).toBe(2)
    const standard = readFileSync(STANDARD_PRESET_PATH, 'utf8')
    expect(standard).not.toContain('You are Endeavour')
    expect(standard).not.toContain('dsh-orbital-agents')
    expect(standard).not.toContain('dsh-endeavour')
  })
})
