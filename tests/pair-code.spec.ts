/**
 * Pair codes and titles: deterministic, unambiguous, collision-resistant, and
 * applied through the OFFICIAL permission/title services only.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  pairCodeFor,
  pairCodeOfTitle,
  pairRootTitleTarget,
  pairTitleFor,
} from '../src/peer.js'

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

const { createCordisPeerSeam } = await import('../src/peer-host.js')

describe('pair code', () => {
  it('is deterministic and stable across module instances', async () => {
    const first = pairCodeFor('pair-cde17c09-2155-5482-8177-89bc30a0326b')
    const second = pairCodeFor('pair-cde17c09-2155-5482-8177-89bc30a0326b')
    expect(first).toBe(second)
    // A fresh import of the same pure function yields the identical code.
    const reloaded = await import('../src/peer.js')
    expect(reloaded.pairCodeFor('pair-cde17c09-2155-5482-8177-89bc30a0326b')).toBe(first)
    expect(pairCodeFor('pair-other')).not.toBe(first)
  })

  it('is six unambiguous uppercase alphanumerics', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = pairCodeFor(`pair-${index}`)
      expect(code).toHaveLength(PAIR_CODE_LENGTH)
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{6}$/)
      for (const char of code) expect(PAIR_CODE_ALPHABET).toContain(char)
      expect(code).not.toMatch(/[IO01]/)
    }
  })

  it('produces no collisions across 1000 pair identities', () => {
    const codes = new Set<string>()
    for (let index = 0; index < 1000; index += 1) codes.add(pairCodeFor(`pair-fixture-${index}`))
    expect(codes.size).toBe(1000)
  })

  it('gives both roles the identical prefix with distinct roles', () => {
    const code = pairCodeFor('pair-x')
    expect(pairTitleFor('endeavour', code)).toBe(`[${code}] Endeavour`)
    expect(pairTitleFor('challenger', code)).toBe(`[${code}] Challenger`)
    expect(pairCodeOfTitle(pairTitleFor('endeavour', code))).toBe(code)
    expect(pairCodeOfTitle(pairTitleFor('challenger', code))).toBe(code)
  })

  it('preserves a meaningful root title and replaces an older code instead of nesting', () => {
    const code = pairCodeFor('pair-y')
    expect(pairRootTitleTarget(code, undefined)).toBe(`[${code}] Endeavour`)
    expect(pairRootTitleTarget(code, '   ')).toBe(`[${code}] Endeavour`)
    expect(pairRootTitleTarget(code, 'Send hi to builder')).toBe(`[${code}] Send hi to builder`)
    // An older/different prefix is REPLACED, never nested.
    expect(pairRootTitleTarget(code, '[ZZZZZZ] Send hi to builder')).toBe(`[${code}] Send hi to builder`)
    // The correct prefix is a no-op.
    expect(pairRootTitleTarget(code, `[${code}] Send hi to builder`)).toBe(`[${code}] Send hi to builder`)
  })
})

describe('host policy seam', () => {
  function policySeam(options: { current?: string; title?: string; failSet?: boolean } = {}) {
    const appended: { sessionId: string; preset: string }[] = []
    const renames: { sessionId: string; title: string }[] = []
    const session = { id: 'session-x', header: { cwd: '/proj', agentPreset: 'challenger' } }
    const ctx = {
      get: (name: string) => {
        if (name === 'sessions') return { get: (id: string) => (id === 'session-x' || id === 'session-root' ? { ...session, id } : undefined), list: () => [] }
        if (name === 'sessionController') return { create: async () => ({}), resolveAgent: async () => ({ agent: { session } }) }
        if (name === 'permissionPresets') {
          return {
            current: () => options.current ?? 'workspace-write',
            set: (target: unknown, preset: string) => {
              if (options.failSet === true) throw new Error('permission service rejected the preset')
              appended.push({ sessionId: (target as { id: string }).id, preset })
            },
          }
        }
        if (name === 'sessionTitle') {
          let current = options.title
          return {
            get: (target: unknown) => (current === undefined ? undefined : { title: current }),
            rename: (target: unknown, title: string) => { current = title; renames.push({ sessionId: (target as { id: string }).id, title }) },
          }
        }
        return undefined
      },
    }
    return { seam: createCordisPeerSeam(ctx), appended, renames }
  }

  it('sets Full access through the official service and is idempotent', async () => {
    const first = policySeam({ current: 'workspace-write' })
    await first.seam.ensurePermissionPreset?.('session-x', 'danger-full-access')
    expect(first.appended).toEqual([{ sessionId: 'session-x', preset: 'danger-full-access' }])
    const already = policySeam({ current: 'danger-full-access' })
    await already.seam.ensurePermissionPreset?.('session-x', 'danger-full-access')
    expect(already.appended).toEqual([])
  })

  it('fails loudly when the preset cannot be guaranteed', async () => {
    const seam = policySeam({ current: 'workspace-write', failSet: true })
    await expect(seam.seam.ensurePermissionPreset?.('session-x', 'danger-full-access')).rejects.toThrow(/rejected/)
  })

  it('applies both pair titles through the official rename', async () => {
    const seam = policySeam({ title: 'Send hi to builder' })
    const code = pairCodeFor('pair-z')
    await seam.seam.ensurePairTitles?.({ pairId: 'pair-z', endeavourSessionId: 'session-root', challengerSessionId: 'session-x' })
    expect(seam.renames).toHaveLength(2)
    expect(seam.renames[0]?.title).toBe(`[${code}] Send hi to builder`)
    expect(seam.renames[1]?.title).toBe(`[${code}] Challenger`)
  })
})
