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
import type {} from '@deepseek-ai/dsh-session'
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
  type WorkspaceRegistryService,
} from './operations.ts'
import { createRegistry, touchActivity } from './registry.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'window-session'

/** Default maximum number of active child windows (budget gate). */
export const DEFAULT_MAX_WINDOWS = 5
/** Default cooperative timeout budget per tool call in milliseconds. */
export const DEFAULT_TOOL_TIMEOUT_MS = 180_000

/** One rung of the ability ladder (mirrors v0.2 §7.1's L1/L2/L3 table). */
export interface LevelConfigInput {
  /** Agent preset id composed into the child window. */
  preset: string
  /** Registered provider route. */
  provider?: string
  /** Provider-owned model id. */
  model?: string
  /** Reasoning effort ("low" | "medium" | "high"). */
  reasoningEffort?: string
}

/**
 * Default three-rung ability ladder (v0.2 §7.1): L1 flash + minimal, L2 pro +
 * standard(high), L3 GLM-5.3 + standard(highest). Deployment should calibrate
 * these to the actually installed providers/models via the `levels` config.
 */
export const DEFAULT_LEVELS = {
  l1: { preset: 'minimal', provider: 'deepseek', model: 'deepseek-v4-flash-0731', reasoningEffort: 'low' },
  l2: { preset: 'standard', provider: 'deepseek', model: 'deepseek-v4-pro-0813', reasoningEffort: 'high' },
  l3: { preset: 'standard', provider: 'zhipu', model: 'glm-5.3', reasoningEffort: 'highest' },
}

/** Hard-dependency services the plugin waits for before apply(). */
export const inject = ['tools', 'systemPrompt', 'agents', 'llm', 'sessionQuery', 'agentPresets']

/** Deployment-owned bounds and the ability ladder. */
export interface Config {
  /** Maximum concurrent child windows. Defaults to 5. */
  maxWindows?: number
  /** Cooperative deadline per tool call in milliseconds. Defaults to 180000. */
  toolTimeoutMs?: number
  /** Fallback level key ("l1" | "l2" | "l3") when window_create omits level. */
  defaultLevel?: string
  /** The ability ladder; each rung expands to a preset + model pair. */
  levels?: {
    l1?: LevelConfigInput
    l2?: LevelConfigInput
    l3?: LevelConfigInput
  }
}

const levelShape = z.object({
  preset: z.string().required(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
})

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  maxWindows: z.number().step(1).min(1).default(DEFAULT_MAX_WINDOWS),
  toolTimeoutMs: z.number().step(1).min(1).default(DEFAULT_TOOL_TIMEOUT_MS),
  defaultLevel: z.string(),
  levels: z.object({
    l1: levelShape,
    l2: levelShape,
    l3: levelShape,
  }).default(DEFAULT_LEVELS),
})

interface ResolvedConfig {
  readonly maxWindows: number
  readonly toolTimeoutMs: number
  readonly defaultLevel: string | undefined
  readonly levels: Readonly<Record<string, import('./operations.ts').LevelConfig>>
}

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render(_args: unknown, value: string) {
    return [{ type: 'text' as const, text: value }]
  },
}

const PROMPT_TEXT =
  'Use window_create to launch a new child window session. Pass level: "l1" | "l2" | "l3" '
  + 'to pick the ability rung (preset/model/effort come from the configured levels table). '
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

  // Live activity feed (D): a tracked child's own surface events advance its
  // lastActivity without any orchestrator tool call, so the scheduler can
  // detect stalls (假死判定, §14.6). Global so child sessions created under the
  // registry root are visible from this preset's scope; filtered by registry
  // membership. Fiber-owned: unwinds with this plugin.
  ctx.on('session/event', (session, _event) => {
    if (store.entries.has(session.id)) touchActivity(store, session.id)
  }, { global: true })

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
    execute: (args, exec) => executeCreate(args, exec, deps, store, {
      ...(resolved.defaultLevel === undefined ? {} : { defaultLevel: resolved.defaultLevel }),
      levels: resolved.levels,
    }),
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
    execute: (args, exec) => Promise.resolve(executeSend(args, exec, deps, store)),
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
    execute: (_args, exec) => Promise.resolve(executeStatus(exec, deps, store)),
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
  const defaultLevel = config.defaultLevel
  const levels = (config.levels ?? DEFAULT_LEVELS) as Readonly<Record<string, import('./operations.ts').LevelConfig>>
  return { maxWindows, toolTimeoutMs, defaultLevel, levels }
}

function resolveDeps(ctx: Context): CtxDeps {
  const agents = ctx.get('agents') as unknown as AgentsService | undefined
  const llm = ctx.get('llm') as unknown as LlmService | undefined
  const sessionQuery = ctx.get('sessionQuery') as unknown as SessionQueryService | undefined
  const agentPresets = ctx.get('agentPresets') as unknown as PresetService | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') as unknown as WorkspaceRegistryService | undefined
  const agentDefaultModel = ctx.get('agentDefaultModel') as unknown as
    { currentSelection(): import('@deepseek-ai/dsh-agent').ModelSelection } | undefined
  if (agents === undefined || llm === undefined || sessionQuery === undefined || agentPresets === undefined) {
    throw new Error('window-session: agents/llm/sessionQuery/agentPresets services are not mounted')
  }
  return {
    agents,
    llm,
    sessionQuery,
    agentPresets,
    workspaceRegistry: workspaceRegistry ?? null,
    ...(agentDefaultModel === undefined ? {} : { agentDefaultModel }),
  }
}
