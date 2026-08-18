/**
 * Business-logic layer for the five window tools.
 *
 * Each exported async function receives the tool's parsed arguments, the
 * calling execution identity, the bound service deps, and the mutable registry.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  createUserMessage,
  ReasoningEffortId,
  type ContentBlock,
  type LlmCallConfig,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { installModelSelection, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { foldSurfaceEvents, type SurfaceEventLike } from './digest.ts'
import {
  assertOwned,
  listAll,
  registerWindow,
  setHandle,
  takeHandle,
  touchActivity,
  unregisterWindow,
  updateStatus,
  type RegistryStore,
} from './registry.ts'

// ---------------------------------------------------------------------------
// Local structural service types (avoid heavy cross-package imports for M0)
// ---------------------------------------------------------------------------

/** The subset of the live Agent surface the operations touch. */
export interface WindowAgent {
  id: string
  status: 'idle' | 'running'
  session: { id: string }
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  cancel(cause: unknown): void
}

/** The owned handle returned by the agents factory. */
interface CreatedHandle {
  agent: WindowAgent
  dispose(): Promise<void>
}

/** The registry-facing agents service (ctx.agents). */
export interface AgentsService {
  create(options: {
    sessionId: string
    agentOptions?: { provider?: string; model?: string }
    meta?: { cwd?: string; agentPreset?: string }
    setup?: (agentCtx: Context) => void | Promise<void>
  }): Promise<CreatedHandle>
  get(id: string): WindowAgent | undefined
}

/** The llm service call used to resolve a model selection. */
export interface LlmService {
  resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig>
}

/** The sessionQuery readSurface service. */
export interface SessionQueryService {
  readSurface(sessionId: string): Promise<{
    session: { id: string }
    capturedThroughSeq: number | null
    events: SurfaceEventLike[]
  }>
}

/** Structural preset service to avoid importing @deepseek-ai/dsh-agent-presets. */
export interface PresetService {
  mount(agentCtx: Context, id?: string): Promise<{ id: string }>
  resolve(id?: string): Promise<{ id: string }>
}

/** The deps resolved once in apply() and threaded into every operation. */
export interface CtxDeps {
  agents: AgentsService
  llm: LlmService
  sessionQuery: SessionQueryService
  agentPresets: PresetService | null
}

/** Caller identity taken from the tool execution context. */
export type CallerIdentity = { agent?: { session: { id: string } } }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callerOf(exec: CallerIdentity): string {
  return exec.agent?.session.id ?? 'unknown'
}

function ownedError(store: RegistryStore, sessionId: string, caller: string): string | null {
  const code = assertOwned(store, sessionId, caller)
  if (code === null) return null
  return code === 'window-not-found'
    ? `window-not-found: window "${sessionId}" was not created by this plugin.`
    : `window-not-owned: caller "${caller}" does not own window "${sessionId}".`
}

// ---------------------------------------------------------------------------
// window_create
// ---------------------------------------------------------------------------

export async function executeCreate(
  args: {
    preset: string
    provider?: string
    model?: string
    reasoningEffort?: string
    cwd?: string
    taskCard?: string
  },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const callerId = callerOf(exec)
  const presets = deps.agentPresets

  // 1. Resolve the model selection (validate + canonicalize) -----------------
  let effectiveModel: ModelSelection | null = null
  if (args.provider !== undefined && args.model !== undefined) {
    const input: LlmCallConfig = {
      provider: args.provider,
      model: args.model,
      ...(args.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(args.reasoningEffort) }),
    }
    try {
      const resolved = await deps.llm.resolveCallConfig(input)
      effectiveModel = {
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: resolved.reasoningEffort }),
      }
    } catch (err: unknown) {
      return JSON.stringify({ error: 'model-unavailable', message: `could not resolve model: ${String(err)}` })
    }
  }

  // 2. Resolve the preset id before create (mirrors api-proxy composeAgent) --
  let presetId = args.preset
  let presetError: string | null = null
  if (presets !== null) {
    try {
      presetId = (await presets.resolve(args.preset)).id
    } catch (err: unknown) {
      presetError = String(err)
    }
  }

  // 3. Compose setup: install selection + mount preset ----------------------
  const selectionRef: ModelSelectionRef | null = effectiveModel === null
    ? null
    : { current: effectiveModel, assembled: undefined }
  const setup = (agentCtx: Context): void | Promise<void> => {
    if (selectionRef !== null) installModelSelection(agentCtx, selectionRef)
    if (presets === null) return undefined
    return presets.mount(agentCtx, presetId).then(() => undefined, () => undefined)
  }

  // 4. Create the agent via ctx.agents (ownerCtx = registry root, sp4) -------
  const sessionId = `window-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const meta = args.cwd === undefined
    ? { agentPreset: presetId }
    : { cwd: args.cwd, agentPreset: presetId }

  let handle: CreatedHandle
  try {
    handle = await deps.agents.create({
      sessionId,
      ...(effectiveModel === null
        ? {}
        : { agentOptions: { provider: effectiveModel.provider, model: effectiveModel.model } }),
      meta,
      setup,
    })
  } catch (err: unknown) {
    return JSON.stringify({ error: 'create-failed', message: String(err) })
  }

  // 5. Register in the budget gate ------------------------------------------
  const taskSummary = args.taskCard?.split('\n')[0]?.trim().slice(0, 60) ?? ''
  const budgetErr = registerWindow(store, {
    sessionId,
    owner: callerId,
    preset: presetId,
    model: effectiveModel?.model ?? null,
    provider: effectiveModel?.provider ?? null,
    reasoningEffort: effectiveModel?.reasoningEffort ?? null,
    taskSummary,
  })
  if (budgetErr !== null) {
    await handle.dispose()
    return JSON.stringify({ error: 'budget-exceeded', message: budgetErr })
  }

  setHandle(store, { agent: { id: handle.agent.id, cancel: cause => handle.agent.cancel(cause) }, dispose: () => handle.dispose() })

  // 6. Inject the task card as the first user message ------------------------
  let note = presetError === null ? '' : `preset-resolve-failed: ${presetError}; `
  if (args.taskCard !== undefined && args.taskCard !== '') {
    const content: ContentBlock[] = [{ type: 'text', text: args.taskCard }]
    try {
      handle.agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
      note += 'task-card queued'
    } catch (err: unknown) {
      note += `task-card injection failed: ${String(err)}`
    }
  }

  return JSON.stringify({
    sessionId,
    agentPreset: presetId,
    cwd: args.cwd ?? null,
    model: effectiveModel?.model ?? null,
    provider: effectiveModel?.provider ?? null,
    reasoningEffort: effectiveModel?.reasoningEffort ?? null,
    note,
  })
}

// ---------------------------------------------------------------------------
// window_read
// ---------------------------------------------------------------------------

export async function executeRead(
  args: { sessionId: string; tailEvents?: number },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify({ error: 'window-not-owned', message: err })

  touchActivity(store, args.sessionId)

  const agent = deps.agents.get(args.sessionId)
  if (agent !== undefined) updateStatus(store, args.sessionId, agent.status)
  const info = listAll(store).find(w => w.sessionId === args.sessionId)

  if (agent !== undefined && agent.status === 'running') {
    try {
      const snapshot = await deps.sessionQuery.readSurface(args.sessionId)
      const count = args.tailEvents ?? 20
      const folded = foldSurfaceEvents(snapshot.events.slice(-count))
      return JSON.stringify({
        sessionId: args.sessionId,
        status: 'running',
        fold: folded,
        lastActivity: info?.lastActivity ?? Date.now(),
      })
    } catch {
      // fall through to status-only response below
    }
  }

  return JSON.stringify({
    sessionId: args.sessionId,
    status: agent?.status ?? 'not-found',
    fold: '[no readable surface events]',
    lastActivity: info?.lastActivity ?? Date.now(),
  })
}

// ---------------------------------------------------------------------------
// window_send
// ---------------------------------------------------------------------------

export async function executeSend(
  args: { sessionId: string; text: string; steer?: boolean },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify({ error: 'window-not-owned', message: err })

  const agent = deps.agents.get(args.sessionId)
  if (agent === undefined) {
    return JSON.stringify({ accepted: false, error: 'window-not-live', message: 'window is no longer live' })
  }

  const content: ContentBlock[] = [{ type: 'text', text: args.text }]
  try {
    const message = createUserMessage({ content, source: { kind: 'user' } })
    if (args.steer === true) agent.steer(message)
    else agent.followup(message)
  } catch (e: unknown) {
    return JSON.stringify({ accepted: false, error: 'send-failed', message: String(e) })
  }

  touchActivity(store, args.sessionId)
  return JSON.stringify({ accepted: true, sessionId: args.sessionId })
}

// ---------------------------------------------------------------------------
// window_close
// ---------------------------------------------------------------------------

export async function executeClose(
  args: { sessionId: string; archive?: boolean },
  exec: CallerIdentity,
  _deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify({ error: 'window-not-owned', message: err })

  const handle = takeHandle(store, args.sessionId)
  if (handle !== undefined) {
    handle.agent.cancel('closed-by-tool')
    try {
      await handle.dispose()
    } catch {
      // disposal is best-effort; the window is still removed from the registry
    }
  }

  unregisterWindow(store, args.sessionId)
  return JSON.stringify({ closed: true, sessionId: args.sessionId, archived: args.archive === true })
}

// ---------------------------------------------------------------------------
// window_status
// ---------------------------------------------------------------------------

export async function executeStatus(
  _exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  for (const w of listAll(store)) {
    const agent = deps.agents.get(w.sessionId)
    if (agent !== undefined) updateStatus(store, w.sessionId, agent.status)
  }

  const refreshed = listAll(store)
  return JSON.stringify({
    active: refreshed.length,
    limit: store.budget,
    windows: refreshed.map(w => ({
      sessionId: w.sessionId,
      preset: w.preset,
      model: w.model,
      provider: w.provider,
      reasoningEffort: w.reasoningEffort,
      status: w.status,
      taskSummary: w.taskSummary,
    })),
  })
}
