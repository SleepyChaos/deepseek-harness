import { describe, expect, it } from 'vitest'
import {
  activeCount,
  assertOwned,
  createRegistry,
  listAll,
  registerWindow,
  unregisterWindow,
} from '../src/registry.ts'
import { foldSurfaceEvents, type SurfaceEventLike } from '../src/digest.ts'

function windowSeed(sessionId: string) {
  return {
    sessionId,
    owner: 'orchestrator',
    preset: 'minimal',
    model: null,
    provider: null,
    reasoningEffort: null,
    taskSummary: 'solve it',
  }
}

describe('window registry budget + ownership', () => {
  it('enforces the concurrency budget and frees slots on close', () => {
    const store = createRegistry(2)
    expect(registerWindow(store, windowSeed('a'))).toBeNull()
    expect(registerWindow(store, windowSeed('b'))).toBeNull()

    const over = registerWindow(store, windowSeed('c'))
    expect(over).toContain('budget-exceeded')
    expect(activeCount(store)).toBe(2)

    expect(unregisterWindow(store, 'a')).toBe(true)
    expect(registerWindow(store, windowSeed('c'))).toBeNull()
    expect(activeCount(store)).toBe(2)
    expect(listAll(store).map(w => w.sessionId).sort()).toEqual(['b', 'c'])
  })

  it('guards ownership: creator-only sends/close', () => {
    const store = createRegistry(5)
    registerWindow(store, windowSeed('a'))

    expect(assertOwned(store, 'a', 'orchestrator')).toBeNull()
    expect(assertOwned(store, 'a', 'intruder')).toBe('window-not-owned')
    expect(assertOwned(store, 'missing', 'orchestrator')).toBe('window-not-found')
  })
})

describe('foldSurfaceEvents digest', () => {
  it('folds user, assistant, and tool-result events into compact text', () => {
    const events: SurfaceEventLike[] = [
      {
        type: 'user/message',
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'solve the pwn' }] },
      },
      {
        type: 'assistant/message',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'found the offset' }] } },
      },
      {
        type: 'tool/result',
        data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '0x4012' }] }, error: undefined },
      },
    ]

    const folded = foldSurfaceEvents(events)
    expect(folded).toContain('solve the pwn')
    expect(folded).toContain('[1:1]')
    expect(folded).toContain('found the offset')
    expect(folded).toContain('tool-result')
    expect(folded).toContain('0x4012')
  })

  it('returns a placeholder for empty input', () => {
    expect(foldSurfaceEvents([])).toBe('[no surface events]')
  })

  it('caps output at the requested budget', () => {
    const events: SurfaceEventLike[] = [{
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'x'.repeat(500) }] },
    }]
    const folded = foldSurfaceEvents(events, 100)
    expect(folded.length).toBeLessThan(150)
  })
})
