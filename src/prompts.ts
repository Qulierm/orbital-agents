/** Project-owned prompt assets, copied into `lib/prompts` by the build. */

import { readFileSync } from 'node:fs'

function load(name: string): string {
  return readFileSync(new URL(`./prompts/${name}`, import.meta.url), 'utf8')
}

/** Endeavour (planner) system role text. */
export const ENDEAVOUR_PROMPT: string = load('endeavour.md')

/** Builder child persona text. */
export const BUILDER_PROMPT: string = load('builder.md')
