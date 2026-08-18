import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type LlmCallConfig, type UserMessage } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WindowSession from '../src/index.ts'

// ---------------------------------------------------------------------------
// Boundary-service mocks (structural; the plugin reads them via ctx.get + cast)
// ---------------------------------------------------------------------------

interface ScriptedAgent {
  id: string
  status: 'idle' | 'running'
  session: { id: string }
  inbox: UserMessage[]
  steered: UserMessage[]
  cancelled: string[]
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  cancel(cause: unknown): void
}

interface Mounted {
  ctx: Context
  created: ScriptedAgent[]
  disposed: string[]
  call: (name: string, args: Record<string, unknown>, callerId: string) => Promise<{ text: string; isError: boolean }>
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function fakeCaller(id: string): Agent {
  return { id, session: { id } } as unknown as Agent
}

async function mount(maxWindows = 5): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const live = new Map<string, ScriptedAgent>()
  const created: ScriptedAgent[] = []
  const disposed: string[] = []

  ctx.provide('agents', {
    async create(options: { sessionId: string }) {
      const agent: ScriptedAgent = {
        id: options.sessionId,
        status: 'idle',
        session: { id: options.sessionId },
        inbox: [],
        steered: [],
        cancelled: [],
        followup(message) {
          this.inbox.push(message)
        },
        steer(message) {
          this.steered.push(message)
        },
        cancel(cause) {
          this.cancelled.push(String(cause))
        },
      }
      live.set(agent.id, agent)
      created.push(agent)
      return {
        agent,
        dispose: async () => {
          live.delete(agent.id)
          disposed.push(agent.id)
        },
      }
    },
    get(id: string) {
      return live.get(id)
    },
  })

  ctx.provide('llm', {
    async resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig> {
      return { ...config, provider: config.provider, model: config.model }
    },
  })

  ctx.provide('sessionQuery', {
    async readSurface(sessionId: string) {
      return { session: { id: sessionId }, capturedThroughSeq: 0, events: [] }
    },
  })

  ctx.provide('agentPresets', {
    async mount(_agentCtx: Context, id: string) {
      return { id }
    },
    async resolve(id: string) {
      return { id }
    },
  })

  await ctx.plugin(WindowSession, { maxWindows })

  return {
    ctx,
    created,
    disposed,
    call: async (name, args, callerId) => {
      const result = await ctx.tools.execute({
        name,
        arguments: args,
        callId: CallId(`call-${name}-${callerId}`),
        signal: new AbortController().signal,
        agent: fakeCaller(callerId),
      })
      const text = result.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
      return { text, isError: result.isError }
    },
  }
}

function json(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('window-session tools (mocked boundary services)', () => {
  it('registers the five tools and a prompt section', async () => {
    const mounted = await mount()
    const names = mounted.ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual([
      'window_create',
      'window_read',
      'window_send',
      'window_close',
      'window_status',
    ])
    const assembly = await mounted.ctx.systemPrompt.assemble()
    expect(assembly.sections.some(section => section.name === 'tool:window-session')).toBe(true)
  })

  it('create -> status -> send(owner) -> close full loop', async () => {
    const mounted = await mount(2)

    const created = json((await mounted.call('window_create', {
      preset: 'minimal',
      taskCard: 'solve the pwn challenge',
    }, 'orchestrator')).text)
    const sessionId = String(created.sessionId)
    expect(sessionId.startsWith('window-')).toBe(true)
    expect(created.agentPreset).toBe('minimal')
    expect(mounted.created).toHaveLength(1)
    const [first] = mounted.created
    expect(first?.inbox).toHaveLength(1)
    expect(first?.inbox[0]?.content.some(
      block => block.type === 'text' && block.text === 'solve the pwn challenge',
    )).toBe(true)

    const status1 = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    expect(status1.active).toBe(1)
    expect(Array.isArray(status1.windows)).toBe(true)

    const sent = json((await mounted.call('window_send', {
      sessionId,
      text: 'keep going',
    }, 'orchestrator')).text)
    expect(sent.accepted).toBe(true)
    expect(first?.inbox).toHaveLength(2)

    const closed = json((await mounted.call('window_close', { sessionId }, 'orchestrator')).text)
    expect(closed.closed).toBe(true)
    expect(mounted.disposed).toContain(sessionId)
    expect(first?.cancelled).toContain('closed-by-tool')

    const status2 = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    expect(status2.active).toBe(0)
  })

  it('rejects cross-owner send / read / close', async () => {
    const mounted = await mount()

    const created = json((await mounted.call('window_create', { preset: 'minimal' }, 'alice')).text)
    const sessionId = String(created.sessionId)

    const deniedSend = json((await mounted.call('window_send', { sessionId, text: 'hi' }, 'mallory')).text)
    expect(deniedSend.error).toBe('window-not-owned')

    const deniedRead = json((await mounted.call('window_read', { sessionId }, 'mallory')).text)
    expect(deniedRead.error).toBe('window-not-owned')

    const deniedClose = json((await mounted.call('window_close', { sessionId }, 'mallory')).text)
    expect(deniedClose.error).toBe('window-not-owned')
    expect(mounted.disposed).toHaveLength(0)
  })

  it('enforces the concurrency budget at the tool boundary', async () => {
    const mounted = await mount(2)

    const a = json((await mounted.call('window_create', { preset: 'minimal' }, 'orchestrator')).text)
    await mounted.call('window_create', { preset: 'minimal' }, 'orchestrator')
    expect(json((await mounted.call('window_status', {}, 'orchestrator')).text).active).toBe(2)

    const c = json((await mounted.call('window_create', { preset: 'minimal' }, 'orchestrator')).text)
    expect(c.error).toBe('budget-exceeded')
    expect(mounted.created).toHaveLength(2)

    await mounted.call('window_close', { sessionId: String(a.sessionId) }, 'orchestrator')
    const d = json((await mounted.call('window_create', { preset: 'minimal' }, 'orchestrator')).text)
    expect(d.sessionId).toBeTruthy()
    expect(mounted.created).toHaveLength(3)
    expect(mounted.disposed).toEqual([String(a.sessionId)])
  })
})
