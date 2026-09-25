/**
 * Generate the bundle's agent-preset patches from the readable preset sources.
 *
 * DSH 0.1.7 replaced directory presets (`~/.dsh/.agent-presets/<id>/` with
 * `agent.cordis.yml` and `preset.yml`, discovered through
 * `@deepseek-ai/dsh-agent-presets` roots) with inline declarations registered by
 * `@deepseek-ai/dsh-agent-preset-registry`. A preset is therefore a row in a
 * Cordis composition, and a bundle ships it by listing the patch file in
 * `dsh.bundle.patch` — the shape `@deepseek-ai/dsh-web-app` uses for its own
 * `presets/standard.patch.yml`.
 *
 * `preset/<id>/` stays the single source of truth; this writes the generated
 * `presets/<id>.patch.yml` the package declares, so the composition keeps its
 * comments and its literal blocks instead of round-tripping through a parser.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load } from 'js-yaml'

/** Preset ids with a `preset/<id>/` source directory. */
export const PRESET_IDS = ['endeavour', 'challenger']

/** Indentation a preset composition row carries under `config.plugins`. */
const PLUGIN_INDENT = ' '.repeat(10)

/**
 * Project one preset source into its bundle patch text.
 * @param root - package root holding `preset/` and receiving `presets/`.
 * @param id - preset id, matching its source directory and registered preset id.
 * @returns the patch file contents.
 */
export function renderPresetPatch(root, id) {
  const source = join(root, 'preset', id, 'agent.cordis.yml')
  const metaSource = join(root, 'preset', id, 'preset.yml')
  const meta = load(readFileSync(metaSource, 'utf8'))
  if (typeof meta !== 'object' || meta === null) throw new Error(`build-presets: ${metaSource} is not a mapping`)
  const { name, description, order } = meta
  if (typeof name !== 'string' || name === '') throw new Error(`build-presets: ${metaSource} has no name`)
  if (typeof description !== 'string' || description === '') throw new Error(`build-presets: ${metaSource} has no description`)
  if (typeof order !== 'number') throw new Error(`build-presets: ${metaSource} has no numeric order`)

  const lines = readFileSync(source, 'utf8').replace(/\n+$/, '').split('\n')
  const firstRow = lines.findIndex((line) => line.startsWith('- id:'))
  if (firstRow < 0) throw new Error(`build-presets: ${source} declares no composition rows`)
  const plugins = lines.slice(firstRow)
    .map((line) => (line === '' ? '' : `${PLUGIN_INDENT}${line}`))
    .join('\n')

  return `# Agent preset ${name}: one \`@deepseek-ai/dsh-agent-preset\` declaration.
#
# Generated from preset/${id}/ by scripts/build-presets.mjs; edit that source.
# The rows mirror the shipped \`standard\` preset, plus the scoped orchestration
# tools row this preset alone mounts.
- insert:
    - id: preset-${id}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${id}
        name: ${name}
        description: ${description}
        order: ${order}
        plugins:
${plugins}
`
}

/**
 * Write every preset patch into `presets/`.
 * @param root - package root holding `preset/` and receiving `presets/`.
 * @returns the written absolute file paths.
 */
export function writePresetPatches(root) {
  const target = join(root, 'presets')
  mkdirSync(target, { recursive: true })
  return PRESET_IDS.map((id) => {
    const file = join(target, `${id}.patch.yml`)
    writeFileSync(file, renderPresetPatch(root, id))
    return file
  })
}
