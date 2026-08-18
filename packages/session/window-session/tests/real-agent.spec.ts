import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createAssistantMessage, createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as WindowSession from '../src/index.ts'

// ---------------------------------------------------------------------------
// Real-boundary mount: REAL AgentRegistry + REAL SessionStore + REAL
// session-query engine; only llm / agentPresets stay mocked (model routing and
// the preset roster are covered by the boundary tests in tools.spec.ts).
// ---------------------------------------------------------------------------

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

function fakeCaller(id: string): Agent {
  return { id, session: { id } } as unknown as Agent
}

interface Mounted {
  ctx: Context
  followups: UserMessage[]
  disposed: string[]
  call: (name: string, args: Record<string, unknown>, callerId: string) => Promise<{ text: string; isError: boolean }>
}

async function mount(maxWindows = 5): Promise<Mounted> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-window-session-real-'))
  temporaryDirectories.push(root)
  const ctx = new Context()
  contexts.push(ctx)

  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: join(root, 'session-query.db') })

  const followups: UserMessage[] = []
  const disposed: string[] = []

  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...(options.meta === undefined ? {} : { meta: options.meta }),
      })
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'running',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          followups.push(message)
          session.append('turn/start', { turn: 1 })
          session.append('step/start', { turn: 1, step: 1 })
          session.append('user/message', message, { surfaceOp: 'append' })
          session.append('assistant/message', {
            turn: 1,
            step: 1,
            message: createAssistantMessage({
              content: [{ type: 'text', text: `scripted answer to ${extractText(message)}` }],
              source: { provider: 'test-provider', model: 'test-model' },
            }),
          }, { surfaceOp: 'append' })
          session.append('step/end', { turn: 1, step: 1 })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => Promise.resolve(),
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      const unregister = ctx.agents.register(agent)
      return {
        agent,
        dispose: async () => {
          unregister()
          disposed.push(agent.id)
        },
      }
    },
    resume: () => Promise.reject(new Error('not used')),
  })

  ctx.provide('llm', {
    async resolveCallConfig(config: { provider: string; model: string; reasoningEffort?: string }) {
      return { ...config }
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
    followups,
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

function extractText(message: UserMessage): string {
  return message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}

// ---------------------------------------------------------------------------
// B — real-boundary integration
// ---------------------------------------------------------------------------

describe('window-session against the real AgentRegistry', () => {
  it('window_create publishes a real agent, then read/send/close work through it', async () => {
    const mounted = await mount()

    const created = json((await mounted.call('window_create', {
      preset: 'minimal',
      taskCard: 'solve the pwn challenge',
    }, 'orchestrator')).text)
    const sessionId = String(created.sessionId)

    // The real registry published the agent: ctx.agents.get returns it.
    const live = mounted.ctx.agents.get(SessionId(sessionId))
    expect(live).toBeDefined()
    expect(live?.session.id).toBe(sessionId)
    expect(live?.options).toEqual({})

    // setup ran with the agent context; the mock preset mount recorded nothing
    // observable, but the task card reached the real agent inbox + session.
    expect(mounted.followups).toHaveLength(1)
    expect(extractText(mounted.followups[0] as UserMessage)).toContain('solve the pwn challenge')

    // window_read folds REAL surface events (user/message + assistant/message)
    // from the real session-query engine.
    const read = json((await mounted.call('window_read', { sessionId }, 'orchestrator')).text)
    expect(read.status).toBe('running')
    const fold = String(read.fold)
    expect(fold).toContain('solve the pwn challenge')
    expect(fold).toContain('scripted answer to solve the pwn challenge')

    // window_send queues another follow-up into the live agent.
    const sent = json((await mounted.call('window_send', { sessionId, text: 'keep going' }, 'orchestrator')).text)
    expect(sent.accepted).toBe(true)
    expect(mounted.followups).toHaveLength(2)

    // window_close disposes the real agent and unregisters it.
    const closed = json((await mounted.call('window_close', { sessionId }, 'orchestrator')).text)
    expect(closed.closed).toBe(true)
    expect(mounted.disposed).toEqual([sessionId])
    expect(mounted.ctx.agents.get(SessionId(sessionId))).toBeUndefined()

    const status = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    expect(status.active).toBe(0)
  })

  it('window_create forwards agentPreset metadata into the real session header', async () => {
    const mounted = await mount()

    const created = json((await mounted.call('window_create', {
      preset: 'minimal',
    }, 'orchestrator')).text)
    const sessionId = String(created.sessionId)

    const live = mounted.ctx.agents.get(SessionId(sessionId))
    expect(live?.session.header.agentPreset).toBe('minimal')
  })

  it('D: child autonomous surface events advance lastActivity via session/event', async () => {
    const mounted = await mount()

    await mounted.call('window_create', { preset: 'minimal' }, 'orchestrator')
    const beforeStatus = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    const beforeWindows = beforeStatus.windows as Array<Record<string, unknown>> | undefined
    const sessionId = String(beforeWindows?.[0]?.sessionId)
    const before = Number(beforeWindows?.[0]?.lastActivity ?? 0)

    // Child works on its own — appends a surface event with no orchestrator
    // tool call in between.
    await new Promise(resolve => setTimeout(resolve, 5))
    const child = mounted.ctx.agents.get(SessionId(sessionId))
    child?.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'child autonomous progress' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const afterStatus = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    const afterWindows = afterStatus.windows as Array<Record<string, unknown>> | undefined
    expect(Number(afterWindows?.[0]?.lastActivity ?? 0)).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// C — queue convergence smoke (batch lifecycle, budget invariant, slot reuse)
// ---------------------------------------------------------------------------

describe('concurrent batch lifecycle (C=1+4 style)', () => {
  it('keeps active windows within the budget while draining a task queue', async () => {
    const mounted = await mount(5)
    const queue = Array.from({ length: 8 }, (_, i) => `task-${i + 1}`)

    const activeWindows = new Set<string>()
    let peak = 0

    while (queue.length > 0) {
      // Dispatch: fill free slots up to the budget (1 container + 4 static style).
      while (activeWindows.size < 5 && queue.length > 0) {
        const task = queue.shift()
        if (task === undefined) break
        const created = json((await mounted.call('window_create', {
          preset: 'minimal',
          taskCard: `solve ${task}`,
        }, 'orchestrator')).text)
        expect(created.sessionId).toBeTruthy()
        activeWindows.add(String(created.sessionId))
        peak = Math.max(peak, activeWindows.size)
        expect(activeWindows.size).toBeLessThanOrEqual(5)
      }

      // Simulate a monitor cycle: every window reports done and is reaped.
      for (const sessionId of [...activeWindows]) {
        const closed = json((await mounted.call('window_close', { sessionId }, 'orchestrator')).text)
        expect(closed.closed).toBe(true)
        activeWindows.delete(sessionId)
      }
    }

    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBe(5) // the budget was genuinely reached before draining
    expect(mounted.disposed).toHaveLength(8)
    const status = json((await mounted.call('window_status', {}, 'orchestrator')).text)
    expect(status.active).toBe(0)
  })
})
