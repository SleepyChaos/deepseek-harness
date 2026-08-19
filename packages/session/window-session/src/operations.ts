/**
 * Business-logic layer for the five window tools.
 *
 * Each exported async function receives the tool's parsed arguments, the
 * calling execution identity, the bound service deps, and the mutable registry.
 */

import { randomUUID } from 'node:crypto'
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
  activeCount,
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

/** One rung of the ability ladder: child preset plus optional model pair and effort. */
export interface LevelConfig {
  preset: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** The configured level table plus the fallback level key. */
export interface Ladder {
  defaultLevel?: string
  levels: Readonly<Record<string, LevelConfig>>
}

/** The optional host service used to persist the `window_close archive` flag. */
export interface WorkspaceRegistryService {
  archiveSession(sessionId: string): Promise<void>
}

/** The deps resolved once in apply() and threaded into every operation. */
export interface CtxDeps {
  agents: AgentsService
  llm: LlmService
  sessionQuery: SessionQueryService
  agentPresets: PresetService
  workspaceRegistry: WorkspaceRegistryService | null
  /** Deployment default model selection, used when no level or explicit pair resolves one. */
  agentDefaultModel?: { currentSelection(): ModelSelection }
}

/** Caller identity taken from the tool execution context. */
export type CallerIdentity = {
  agent?: { session: { id: string; header?: { cwd?: string } } }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callerOf(exec: CallerIdentity): string | null {
  return exec.agent?.session.id ?? null
}

type OwnershipErrorCode = 'window-not-found' | 'window-not-owned' | 'window-no-caller'

function ownedError(
  store: RegistryStore,
  sessionId: string,
  caller: string | null,
): { error: OwnershipErrorCode; message: string } | null {
  if (caller === null) {
    return {
      error: 'window-no-caller',
      message: 'window tools require a live caller session; refusing an anonymous owner',
    }
  }
  const code = assertOwned(store, sessionId, caller)
  if (code === null) return null
  return code === 'window-not-found'
    ? { error: 'window-not-found', message: `window-not-found: window "${sessionId}" was not created by this plugin.` }
    : { error: 'window-not-owned', message: `window-not-owned: caller "${caller}" does not own window "${sessionId}".` }
}

// ---------------------------------------------------------------------------
// window_create
// ---------------------------------------------------------------------------

/**
 * Create and register one child window under the caller's ownership.
 * @param args - Level marker, preset/model overrides, workspace, and optional task-card inputs.
 * @param exec - Tool execution identity used for ownership and workspace defaults.
 * @param deps - Host services used to create and compose the child.
 * @param store - Registry carrying budget and ownership state.
 * @param ladder - The configured ability-level table and its default level key.
 * @returns JSON text describing the created window or a structured failure.
 */
export async function executeCreate(
  args: {
    level?: string
    preset?: string
    provider?: string
    model?: string
    reasoningEffort?: string
    cwd?: string
    taskCard?: string
  },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
  ladder: Ladder,
): Promise<string> {
  const callerId = callerOf(exec)
  if (callerId === null) {
    return JSON.stringify({
      error: 'window-no-caller',
      message: 'window_create requires a live caller session; refusing an anonymous owner',
    })
  }
  const presets = deps.agentPresets

  // Resolve the ability level: explicit marker first, else the configured default.
  const levelKey = args.level ?? ladder.defaultLevel
  const level = levelKey === undefined ? undefined : ladder.levels[levelKey]

  // Model pair: an explicit provider/model pair wins wholesale over the level's
  // pair; reasoningEffort merges independently. A pair must be complete.
  const explicitPair = args.provider !== undefined || args.model !== undefined
  const provider = explicitPair ? args.provider : level?.provider
  const model = explicitPair ? args.model : level?.model
  const reasoningEffort = args.reasoningEffort ?? level?.reasoningEffort
  if ((provider === undefined) !== (model === undefined)) {
    return JSON.stringify({
      error: 'invalid-model-selection',
      message: 'provider and model must be supplied together',
    })
  }

  // 0. Budget gate BEFORE create (avoid create-then-dispose churn) ----------
  if (activeCount(store) >= store.budget) {
    return JSON.stringify({
      error: 'budget-exceeded',
      message: `window-budget-exceeded: active windows (${activeCount(store)}) reached limit (${store.budget}); close one first.`,
    })
  }

  // 1. Resolve the model selection (validate + canonicalize) -----------------
  let effectiveModel: ModelSelection | null = null
  if (provider !== undefined && model !== undefined) {
    const input: LlmCallConfig = {
      provider,
      model,
      ...(reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(reasoningEffort) }),
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
  } else if (deps.agentDefaultModel !== undefined) {
    // No level model and no explicit pair: the child still needs a model for
    // prompt assembly ({{model}}), so fall back to the deployment default.
    effectiveModel = deps.agentDefaultModel.currentSelection()
  }

  // 2. Resolve the preset id before create (mirrors api-proxy composeAgent) --
  const presetRequest = args.preset ?? level?.preset ?? 'minimal'
  let presetId: string
  try {
    presetId = (await presets.resolve(presetRequest)).id
  } catch (err: unknown) {
    return JSON.stringify({ error: 'preset-unavailable', message: `could not resolve preset "${presetRequest}": ${String(err)}` })
  }

  // 3. Compose setup: install selection + mount preset ----------------------
  const selectionRef: ModelSelectionRef | null = effectiveModel === null
    ? null
    : { current: effectiveModel, assembled: undefined }
  const setup = async (agentCtx: Context): Promise<void> => {
    if (selectionRef !== null) installModelSelection(agentCtx, selectionRef)
    await presets.mount(agentCtx, presetId)
  }

  // 4. Create the agent via ctx.agents (ownerCtx = registry root, sp4) -------
  const sessionId = `window-${randomUUID()}`
  const cwd = args.cwd ?? exec.agent?.session.header?.cwd
  const meta = cwd === undefined
    ? { agentPreset: presetId }
    : { cwd, agentPreset: presetId }

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

  setHandle(store, {
    agent: { id: handle.agent.id, cancel: (cause) => { handle.agent.cancel(cause) } },
    dispose: () => handle.dispose(),
  })

  // 6. Inject the task card as the first user message ------------------------
  let note = ''
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
    level: levelKey ?? null,
    agentPreset: presetId,
    cwd: cwd ?? null,
    model: effectiveModel?.model ?? null,
    provider: effectiveModel?.provider ?? null,
    reasoningEffort: effectiveModel?.reasoningEffort ?? null,
    note,
  })
}

// ---------------------------------------------------------------------------
// window_read
// ---------------------------------------------------------------------------

/**
 * Read a bounded model-surface digest for an owned child window.
 * @param args - Target session and optional tail-event count.
 * @param exec - Tool execution identity used for ownership validation.
 * @param deps - Host services used to read the surface and inspect status.
 * @param store - Registry carrying ownership and activity state.
 * @returns JSON text containing status, digest, and activity metadata.
 */
export async function executeRead(
  args: { sessionId: string; tailEvents?: number },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify(err)

  touchActivity(store, args.sessionId)

  const agent = deps.agents.get(args.sessionId)
  if (agent !== undefined) updateStatus(store, args.sessionId, agent.status)
  const info = listAll(store).find(w => w.sessionId === args.sessionId)
  const count = args.tailEvents ?? 20
  if (!Number.isSafeInteger(count) || count < 1) {
    return JSON.stringify({ error: 'invalid-tail-events', message: 'tailEvents must be a positive safe integer' })
  }

  try {
    const snapshot = await deps.sessionQuery.readSurface(args.sessionId)
    const folded = foldSurfaceEvents(snapshot.events.slice(-count))
    return JSON.stringify({
      sessionId: args.sessionId,
      status: agent?.status ?? 'not-found',
      fold: folded,
      lastActivity: info?.lastActivity ?? Date.now(),
    })
  } catch {
    // fall through to status-only response below
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

/**
 * Queue or steer one user message into an owned live child window.
 * @param args - Target session, text, and optional steering mode.
 * @param exec - Tool execution identity used for ownership validation.
 * @param deps - Host agent service used to find the child.
 * @param store - Registry carrying ownership and activity state.
 * @returns JSON text describing acceptance or the send failure.
 */
export function executeSend(
  args: { sessionId: string; text: string; steer?: boolean },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): string {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify(err)

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

/**
 * Archive when requested, stop, dispose, and unregister an owned child.
 * @param args - Target session and optional durable-archive flag.
 * @param exec - Tool execution identity used for ownership validation.
 * @param deps - Host services used for archive and disposal.
 * @param store - Registry carrying ownership and handle state.
 * @returns JSON text describing closure or a retryable failure.
 */
export async function executeClose(
  args: { sessionId: string; archive?: boolean },
  exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): Promise<string> {
  const err = ownedError(store, args.sessionId, callerOf(exec))
  if (err !== null) return JSON.stringify(err)

  if (args.archive === true) {
    if (deps.workspaceRegistry === null) {
      return JSON.stringify({
        closed: false,
        error: 'archive-unavailable',
        message: 'workspaceRegistry is not mounted; the session was not closed',
      })
    }
    try {
      await deps.workspaceRegistry.archiveSession(args.sessionId)
    } catch (err: unknown) {
      return JSON.stringify({
        closed: false,
        error: 'archive-failed',
        message: `could not archive window "${args.sessionId}": ${String(err)}`,
      })
    }
  }

  const handle = store.handles.get(args.sessionId)
  if (handle !== undefined) {
    try {
      handle.agent.cancel('closed-by-tool')
      await handle.dispose()
    } catch (err: unknown) {
      return JSON.stringify({
        closed: false,
        error: 'close-failed',
        message: `could not close window "${args.sessionId}": ${String(err)}`,
      })
    }
    takeHandle(store, args.sessionId)
  }

  unregisterWindow(store, args.sessionId)
  return JSON.stringify({ closed: true, sessionId: args.sessionId, archived: args.archive === true })
}

// ---------------------------------------------------------------------------
// window_status
// ---------------------------------------------------------------------------

/**
 * Refresh and return all currently tracked child-window snapshots.
 * @param _exec - Unused tool execution identity retained for a uniform tool signature.
 * @param deps - Host agent service used to refresh live statuses.
 * @param store - Registry carrying tracked windows and budget state.
 * @returns JSON text containing the active count, limit, and window summaries.
 */
export function executeStatus(
  _exec: CallerIdentity,
  deps: CtxDeps,
  store: RegistryStore,
): string {
  for (const w of listAll(store)) {
    const agent = deps.agents.get(w.sessionId)
    if (agent === undefined) {
      store.entries.delete(w.sessionId)
      store.handles.delete(w.sessionId)
    } else {
      updateStatus(store, w.sessionId, agent.status)
    }
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
      lastActivity: w.lastActivity,
    })),
  })
}
