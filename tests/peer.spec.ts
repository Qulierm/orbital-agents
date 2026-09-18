/**
 * Persistent peer pair domain: deterministic companion ids, strict reciprocal
 * validation, registry indexing, replay folding, and the Challenger preset.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  challengerSessionIdFor,
  createPeerState,
  foldPeerEvents,
  peerEventPayload,
  PeerError,
  peerPairIdFor,
  PeerRegistry,
  peerOf,
  peerRoleOf,
  validatePeerState,
} from '../src/peer.js'

describe('deterministic companion ids', () => {
  it('derives a stable collision-safe ordinary session id', () => {
    const a = challengerSessionIdFor('session-aaa')
    expect(a).toBe(challengerSessionIdFor('session-aaa'))
    expect(a).toMatch(/^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(challengerSessionIdFor('session-bbb')).not.toBe(a)
    expect(peerPairIdFor('session-aaa')).not.toBe(peerPairIdFor('session-bbb'))
    expect(challengerSessionIdFor('session-aaa')).not.toBe('session-aaa')
    expect(() => challengerSessionIdFor('')).toThrow(PeerError)
  })
})

describe('pair state', () => {
  it('creates a valid reciprocal pair and rejects tampering', () => {
    const state = createPeerState({ endeavourSessionId: 'session-aaa', at: 5 })
    expect(validatePeerState(state)).toEqual([])
    expect(peerRoleOf(state, 'session-aaa')).toBe('endeavour')
    expect(peerRoleOf(state, state.challengerSessionId)).toBe('challenger')
    expect(peerOf(state, 'session-aaa')).toBe(state.challengerSessionId)
    expect(peerOf(state, state.challengerSessionId)).toBe('session-aaa')
    expect(peerOf(state, 'session-other')).toBeUndefined()
    expect(validatePeerState({ ...state, challengerSessionId: 'session-forged' })).toContain(
      'challengerSessionId is not the deterministic companion of the Endeavour session')
    expect(validatePeerState({ ...state, endeavourSessionId: state.challengerSessionId }))
      .toContain('pair members must be distinct sessions')
    expect(validatePeerState(undefined)).toEqual(['missing peer state'])
  })

  it('indexes both sides in a registry and folds replays by sequence', () => {
    const registry = new PeerRegistry()
    const first = createPeerState({ endeavourSessionId: 'session-a', at: 1 })
    registry.set(first)
    registry.set(createPeerState({ endeavourSessionId: 'session-b', at: 1 }))
    expect(registry.has('session-a')).toBe(true)
    expect(registry.roleOf(first.challengerSessionId)).toBe('challenger')
    expect(registry.peerOf(first.challengerSessionId)).toBe('session-a')
    expect(registry.pairs()).toHaveLength(2)
    expect(() => registry.set({ ...first, pairId: 'forged' })).toThrow(PeerError)

    const update = { ...first, sequence: 2, updatedAt: 9 }
    const folded = foldPeerEvents([peerEventPayload('peer-created', undefined, first, 1), peerEventPayload('peer-updated', first, update, 9)])
    expect(folded?.sequence).toBe(2)
    expect(foldPeerEvents([peerEventPayload('peer-created', undefined, first, 1), peerEventPayload('peer-created', undefined, first, 1)])?.sequence).toBe(1)
  })

  it('stays free of subagent vocabulary in the new runtime module', () => {
    const source = readFileSync('src/peer.ts', 'utf8')
    expect(source).not.toMatch(/startContinuable|openSubagent|SubagentAddress|subagents\./)
  })
})

describe('Challenger preset', () => {
  it('installs a selectable ordinary preset with the Challenger persona and no Endeavour tools', () => {
    const metadata = readFileSync('preset/challenger/preset.yml', 'utf8')
    expect(metadata).toMatch(/^name: Challenger$/m)
    expect(metadata).toMatch(/^description: [\x20-\x7E]+$/m)
    expect(metadata).not.toMatch(/[А-Яа-яЁё]/)
    const agent = readFileSync('preset/challenger/agent.cordis.yml', 'utf8')
    expect(agent).not.toContain('endeavour-tools')
    expect(agent).not.toMatch(/send_message|subagent_fork/)
    const prompt = readFileSync('src/prompts/challenger.md', 'utf8')
    const indented = prompt.replace(/\n$/, '').split('\n').map((line) => (line === '' ? '' : `      ${line}`)).join('\n')
    expect(agent).toContain(`    prefix: |\n${indented}\n`)
    expect(prompt).toMatch(/never act as\s+a subagent/i)
    expect(prompt).toMatch(/challenger_start_task/)
    expect(prompt).toMatch(/challenger_report/)
  })
})
