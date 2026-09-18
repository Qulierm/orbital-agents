/** Project-owned prompt assets, copied into `lib/prompts` by the build. */

import { readFileSync } from 'node:fs'

function load(name: string): string {
  return readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8')
}

/** Endeavour (planner) system role text. */
export const ENDEAVOUR_PROMPT: string = load('endeavour.md')

/**
 * Executor persona text: the persistent Challenger peer. The export name is
 * kept for the legacy service until the C2 cutover renames it.
 */
export const BUILDER_PROMPT: string = load('challenger.md')
