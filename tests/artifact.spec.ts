/**
 * Loader-artifact regression tests.
 *
 * These fail the pre-fix artifact (top-level ESM) and pin the official
 * `window.__ModuleLoader__.load({ id, factory })` contract, the loader-`require`
 * dependency set, React externalization, and coexistence with an official
 * v0.1.5-rc.2 client artifact (dsh-client-hmr).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClientCode, CLIENT_ENTRY, CLIENT_ID } from '../scripts/client-build.ts'

const APP_MODULES = process.env.DSH_APP_MODULES
  ?? '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'

interface Registration {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => Record<string, unknown>
}

function mockLoader() {
  const registrations = new Map<string, Registration>()
  const window = {
    __ModuleLoader__: {
      load(registration: Registration) {
        if (registrations.has(registration.id)) {
          throw new Error(`duplicate factory registration for "${registration.id}"`)
        }
        registrations.set(registration.id, registration)
      },
    },
  }
  return { window, registrations }
}

function evaluate(code: string, window: unknown): void {
  // Classic-script evaluation: a top-level `import`/`export` is a SyntaxError here.
  const run = new Function('window', code)
  run(window)
}

describe('client artifact (ModuleLoader contract)', () => {
  it('is a classic script that registers exactly id dsh-endeavour', async () => {
    const code = await buildClientCode()
    expect(code).not.toMatch(/^\s*(?:import|export)\b/m)
    const { window, registrations } = mockLoader()
    expect(() => { evaluate(code, window) }).not.toThrow()
    expect([...registrations.keys()]).toEqual([CLIENT_ID])
  })

  it('factory returns module.exports exposing apply and inject', async () => {
    const code = await buildClientCode()
    const { window, registrations } = mockLoader()
    evaluate(code, window)
    const registration = registrations.get(CLIENT_ID)
    expect(registration).toBeDefined()
    const requested: string[] = []
    const react = {
      useState: () => [undefined, () => undefined],
      useEffect: () => undefined,
      createElement: () => null,
      Fragment: Symbol('Fragment'),
    }
    const jsxRuntime = { jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment') }
    const exports = registration!.factory((id: string) => {
      requested.push(id)
      if (id === 'react') return react
      if (id === 'react/jsx-runtime') return jsxRuntime
      throw new Error(`unexpected loader require "${id}"`)
    })
    expect(typeof exports.apply).toBe('function')
    expect(Array.isArray(exports.inject)).toBe(true)
    expect(exports.inject).toContain('uiConversation')
    // Only loader-provided runtime externals; no duplicate React implementation.
    expect(new Set(requested)).toEqual(new Set(['react', 'react/jsx-runtime']))
    expect(code).not.toContain('ReactCurrentDispatcher')
    expect(code).not.toContain('__vite')
  })

  it('cannot prevent official dsh-client-hmr registration (combined smoke)', async () => {
    const officialHmr = join(APP_MODULES, 'dsh-client-hmr/lib/client.js')
    if (!existsSync(officialHmr)) {
      console.warn(`artifact-smoke: official hmr artifact not found at ${officialHmr}; skipping combined smoke`)
      return
    }
    const { window, registrations } = mockLoader()
    evaluate(readFileSync(officialHmr, 'utf8'), window)
    expect(registrations.has('@deepseek-ai/dsh-client-hmr')).toBe(true)
    const ours = await buildClientCode()
    evaluate(ours, window)
    expect(registrations.has('@deepseek-ai/dsh-client-hmr')).toBe(true)
    expect(registrations.has(CLIENT_ID)).toBe(true)
    expect([...registrations.keys()]).toContain('@deepseek-ai/dsh-client-hmr')
  })

  it('keeps the package manifest consistent with the loader contract', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      name: string
      files: string[]
      dsh: { client: { platform: string; inject: string[] }; bundle: { patch: string } }
      exports: Record<string, { default: string }>
    }
    expect(manifest.name).toBe(CLIENT_ID)
    expect(manifest.dsh.client.platform).toBe('web')
    expect(manifest.exports['./client']?.default).toBe('./lib/client.js')
    expect(manifest.files).toContain('lib')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(existsSync(manifest.dsh.bundle.patch)).toBe(true)
    expect(existsSync(CLIENT_ENTRY)).toBe(true)
    expect(existsSync('preset/endeavour.patch.yml')).toBe(true)
  })
})
