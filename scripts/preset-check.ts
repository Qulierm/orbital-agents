/**
 * Preset contract and drift checker.
 *
 * The Endeavour preset is version-pinned to the exact standard composition
 * shipped inside the installed DSH Desktop rc.2 payload. This check proves:
 * - every standard row is retained (full coding tool composition),
 * - the only composition differences are the persona prefix and the appended
 *   scoped tools row,
 * - the embedded persona equals the packaged `src/prompts/endeavour.md`,
 * - the cwd suffix and runtime-context rows are preserved,
 * - the installed standard preset itself is untouched by us.
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_SCHEMA, load, Type } from 'js-yaml'

/** DSH expression tag (`!!js`); parsed as its raw scalar text, never evaluated. */
const JS_EXPRESSION_TAG = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data: string) => data,
})

const COMPOSITION_SCHEMA = DEFAULT_SCHEMA.extend([JS_EXPRESSION_TAG])

/** Parse a composition file with DSH's `!!js` tag accepted as text. */
export function loadRows(path: string): Row[] {
  const parsed = load(readFileSync(path, 'utf8'), { schema: COMPOSITION_SCHEMA })
  if (!Array.isArray(parsed)) throw new Error(`preset-check: ${path} is not a top-level row list`)
  return parsed as Row[]
}

/** Default installed source of truth for the standard preset. */
export const STANDARD_PRESET_PATH = process.env.DSH_STANDARD_PRESET
  ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-agent-presets/presets/standard/agent.cordis.yml'

/** Relative package path our preset row resolves through. */
export const TOOLS_ROW_NAME = './node_modules/dsh-endeavour/lib/tools-plugin.js'

interface Row {
  readonly id?: string
  readonly name?: string
  readonly config?: Record<string, unknown>
  readonly [key: string]: unknown
}

function rowsOf(path: string): Row[] {
  return loadRows(path)
}

function personaPrefix(rows: Row[]): string {
  const row = rows.find((candidate) => candidate.id === 'persona')
  const config = row?.config as { prefix?: unknown } | undefined
  if (typeof config?.prefix !== 'string') throw new Error('preset-check: persona prefix is missing')
  return config.prefix
}

/** Run every preset contract check; returns a list of failure messages. */
export function checkPreset(): string[] {
  const failures: string[] = []
  const ours = rowsOf('preset/endeavour/agent.cordis.yml')
  const standard = rowsOf(STANDARD_PRESET_PATH)
  const prompt = readFileSync('src/prompts/endeavour.md', 'utf8')

  if (personaPrefix(ours) !== prompt) {
    failures.push('embedded persona prefix diverged from src/prompts/endeavour.md')
  }
  const suffix = (ours.find((row) => row.id === 'persona')?.config as { suffix?: unknown } | undefined)?.suffix
  if (typeof suffix !== 'string' || !suffix.includes('{{cwd}}')) {
    failures.push('persona cwd suffix was not preserved')
  }

  const toolsRows = ours.filter((row) => row.id === 'endeavour-tools')
  if (toolsRows.length !== 1 || toolsRows[0]?.name !== TOOLS_ROW_NAME) {
    failures.push(`missing or wrong scoped tools row (expected ${TOOLS_ROW_NAME})`)
  }
  if (ours.filter((row) => row.name === TOOLS_ROW_NAME).length !== 1) {
    failures.push('scoped tools row must appear exactly once')
  }

  const oursWithoutTools = ours.filter((row) => row.id !== 'endeavour-tools')
  if (oursWithoutTools.length !== standard.length) {
    failures.push(`row count differs from standard (${String(oursWithoutTools.length)} vs ${String(standard.length)})`)
  }
  for (const [index, standardRow] of standard.entries()) {
    const ourRow = oursWithoutTools[index]
    if (ourRow === undefined) {
      failures.push(`missing row ${String(standardRow.id)} at position ${String(index + 1)}`)
      continue
    }
    if (ourRow.id !== standardRow.id || ourRow.name !== standardRow.name) {
      failures.push(`row ${String(index + 1)} diverged: ${String(standardRow.id)} vs ${String(ourRow?.id)}`)
      continue
    }
    if (standardRow.id === 'persona') continue
    if (JSON.stringify(ourRow.config) !== JSON.stringify(standardRow.config)) {
      failures.push(`config drift in row ${String(standardRow.id)}`)
    }
  }
  if (standard.some((row) => row.id === 'endeavour-tools')) {
    failures.push('installed standard preset unexpectedly contains our tools row')
  }

  // Challenger: ordinary coding preset with its own persona, no orchestration
  // tools, and no delegation/messaging mounts.
  const challengerRows = rowsOf('preset/challenger/agent.cordis.yml')
  const challengerPrompt = readFileSync('src/prompts/challenger.md', 'utf8')
  if (personaPrefix(challengerRows) !== challengerPrompt) {
    failures.push('embedded Challenger persona diverged from src/prompts/challenger.md')
  }
  if (challengerRows.some((row) => String(row.id ?? '').startsWith('tool-subagent'))) {
    failures.push('Challenger preset must not mount subagent/delegation tools')
  }
  if (challengerRows.some((row) => row.id === 'endeavour-tools' || row.name === TOOLS_ROW_NAME)) {
    failures.push('Challenger preset must not mount the Endeavour orchestration tools')
  }
  const challengerText = readFileSync('preset/challenger/agent.cordis.yml', 'utf8')
  if (/send_message|subagent_fork/.test(challengerText)) {
    failures.push('Challenger preset references forbidden messaging/delegation tools')
  }
  const challengerMeta = readFileSync('preset/challenger/preset.yml', 'utf8')
  if (!/^name: Challenger$/m.test(challengerMeta)) failures.push('Challenger metadata name must be exactly "Challenger"')
  if (!/^description: [\x20-\x7E]+$/m.test(challengerMeta)) failures.push('Challenger metadata description must be printable ASCII')
  return failures
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')
if (invokedDirectly) {
  const failures = checkPreset()
  if (failures.length > 0) {
    console.error(`preset-check: FAIL\n- ${failures.join('\n- ')}`)
    process.exitCode = 1
  } else {
    console.log(`preset-check: PASS (standard=${STANDARD_PRESET_PATH})`)
  }
}
