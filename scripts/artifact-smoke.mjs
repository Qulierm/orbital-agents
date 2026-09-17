#!/usr/bin/env node
/**
 * Execute one built client artifact under a mock DSH ModuleLoader.
 *
 * Usage: node scripts/artifact-smoke.mjs [path/to/client.js]
 *
 * Verifies classic-script execution, exact registration id, factory exports,
 * loader-only requires (react/react-jsx-runtime), and coexistence with the
 * official v0.1.5-rc.2 dsh-client-hmr artifact when the app is installed.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const path = process.argv[2] ?? 'lib/client.js'
const EXPECTED_ID = 'dsh-endeavour'
const APP_MODULES = process.env.DSH_APP_MODULES
  ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'

function mockLoader() {
  const registrations = new Map()
  const window = {
    __ModuleLoader__: {
      load(registration) {
        if (registrations.has(registration.id)) throw new Error(`duplicate registration ${registration.id}`)
        registrations.set(registration.id, registration)
      },
    },
  }
  return { window, registrations }
}

function evaluate(code, window) {
  new Function('window', code)(window)
}

const code = readFileSync(path, 'utf8')
const hash = createHash('sha256').update(code).digest('hex')
const { window, registrations } = mockLoader()

// Official artifact first: our script must not prevent its registration.
const officialHmr = `${APP_MODULES}/dsh-client-hmr/lib/client.js`
let hmrChecked = false
if (existsSync(officialHmr)) {
  evaluate(readFileSync(officialHmr, 'utf8'), window)
  if (!registrations.has('@deepseek-ai/dsh-client-hmr')) throw new Error('official hmr artifact did not register')
  hmrChecked = true
}

evaluate(code, window)
const registration = registrations.get(EXPECTED_ID)
if (registration === undefined) throw new Error(`artifact did not register "${EXPECTED_ID}"`)
if (registrations.has('@deepseek-ai/dsh-client-hmr') !== hmrChecked) {
  throw new Error('our artifact changed the official hmr registration state')
}

const requested = []
const exports = registration.factory((id) => {
  requested.push(id)
  if (id === 'react' || id === 'react/jsx-runtime') return { useState: () => [], useEffect: () => undefined, createElement: () => null, jsx: () => null, jsxs: () => null, Fragment: null }
  throw new Error(`unexpected loader require "${id}"`)
})
if (typeof exports.apply !== 'function') throw new Error('factory exports missing apply')
if (!Array.isArray(exports.inject)) throw new Error('factory exports missing inject array')
if (/^\s*(?:import|export)\b/m.test(code)) throw new Error('artifact contains top-level ESM syntax')

console.log(`artifact-smoke: PASS ${path}`)
console.log(`  sha256=${hash}`)
console.log(`  id=${EXPECTED_ID}; requires=${[...new Set(requested)].join(',')}; hmr-coexistence=${hmrChecked ? 'checked' : 'skipped (app artifact absent)'}`)
