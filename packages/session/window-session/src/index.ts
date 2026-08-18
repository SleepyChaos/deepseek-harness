/**
 * Model-facing Cordis plugin for window-session orchestration.
 *
 * Registers five tools plus a concise guidance section so the model knows
 * when and how to create / drive / read / close child windows.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  windowCreateParameters,
  windowReadParameters,
  windowSendParameters,
  windowCloseParameters,
  windowStatusParameters,
} from './input.ts'
import {
  executeCreate,
  executeRead,
  executeSend,
  executeClose,
  executeStatus,
  type CtxDeps,
  type AgentsService,
  type LlmService,
  type SessionQueryService,
  type PresetService,
} from './operations.ts'
import { createRegistry } from './registry.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'window-session'

/** Default maximum number of active child windows (budget gate). */
export const DEFAULT_MAX_WINDOWS = 5
/** Default cooperative timeout budget per tool call in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000

/** Hard-dependency services the plugin waits for before apply(). */
export const inject = ['tools', 'systemPrompt', 'agents', 'llm', 'sessionQuery', 'agentPresets']

/** Deployment-owned bounds. */
export interface Config {
  /** Maximum concurrent child windows. Defaults to 5. */
  maxWindows?: number
  /** Cooperative deadline per tool call in milliseconds. Defaults to 180000. */
  toolTimeoutMs?: number
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxWindows: z.number().step(1).min(1).default(DEFAULT_MAX_WINDOWS),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
})

interface ResolvedConfig {
  readonly maxWindows: number
  readonly toolTimeoutMs: number
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render(_args: unknown, value: string) {
    return [{ type: 'text' as const, text: value }]
  },
}

const PROMPT_TEXT =
  'Use window_create to launch a new child window session with a specific preset. '
  + 'Monitor progress with window_read after each step. '
  + 'Use window_send to dispatch follow-up instructions or steer an active turn. '
  + 'Use window_status to see all active windows at once. '
  + 'Use window_close when a child finishes its work to free a slot. '
  + 'At most one concurrent window per budget unit.'

/** Register all five tools and their shared model guidance. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const deps = resolveDeps(ctx)
  const store = createRegistry(resolved.maxWindows)

  ctx.systemPrompt.section({
    name: 'tool:window-session',
    order: 120,
    text: PROMPT_TEXT,
  })

  ctx.tools.register(defineTool({
    name: 'window_create',
    description: 'Create a new ordinary child-window session under the caller workspace.',
    parameters: windowCreateParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.toolTimeoutMs,
    execute: (args, exec) => executeCreate(args, exec, deps, store),
  }))

  ctx.tools.register(defineTool({
    name: 'window_read',
    description: 'Read the latest surface events of a child window and return a compact digest.',
    parameters: windowReadParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.toolTimeoutMs,
    execute: (args, exec) => executeRead(args, exec, deps, store),
  }))

  ctx.tools.register(defineTool({
    name: 'window_send',
    description: 'Inject a user message into a child window (queue as follow-up or steer into current turn).',
    parameters: windowSendParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.toolTimeoutMs,
    execute: (args, exec) => executeSend(args, exec, deps, store),
  }))

  ctx.tools.register(defineTool({
    name: 'window_close',
    description: 'Stop a child window run and release it from the budget registry.',
    parameters: windowCloseParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.toolTimeoutMs,
    execute: (args, exec) => executeClose(args, exec, deps, store),
  }))

  ctx.tools.register(defineTool({
    name: 'window_status',
    description: 'Return a summary of all tracked windows with id, preset, model, status, and task tag.',
    parameters: windowStatusParameters,
    output: TEXT_OUTPUT,
    timeoutMs: resolved.toolTimeoutMs,
    execute: (_args, exec) => executeStatus(exec, deps, store),
  }))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveConfig(config: Config): ResolvedConfig {
  const maxWindows = config.maxWindows ?? DEFAULT_MAX_WINDOWS
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1) {
    throw new TypeError('window-session: maxWindows must be a positive safe integer')
  }
  const toolTimeoutMs = config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  if (!Number.isSafeInteger(toolTimeoutMs) || toolTimeoutMs < 1) {
    throw new TypeError('window-session: toolTimeoutMs must be a positive safe integer')
  }
  return { maxWindows, toolTimeoutMs }
}

function resolveDeps(ctx: Context): CtxDeps {
  const agents = ctx.get('agents') as unknown as AgentsService | undefined
  const llm = ctx.get('llm') as unknown as LlmService | undefined
  const sessionQuery = ctx.get('sessionQuery') as unknown as SessionQueryService | undefined
  const agentPresets = ctx.get('agentPresets') as unknown as PresetService | undefined
  if (agents === undefined || llm === undefined || sessionQuery === undefined) {
    throw new Error('window-session: agents/llm/sessionQuery services are not mounted')
  }
  return { agents, llm, sessionQuery, agentPresets: agentPresets ?? null }
}
