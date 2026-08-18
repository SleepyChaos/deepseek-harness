/**
 * Window runtime registry: budget gate, ownership tracking, and status.
 *
 * Lives in the Cordis-plugin closure so each mounted instance gets its own copy.
 * All public methods are synchronous for use inside `defineTool.execute` callbacks.
 */

/** Lightweight snapshot of one tracked window's metadata (pure JSON-safe data). */
export interface WindowInfo {
  sessionId: string
  owner: string
  preset: string
  model: string | null
  provider: string | null
  reasoningEffort: string | null
  status: 'idle' | 'running'
  createdAt: number
  lastActivity: number
  taskSummary: string
}

/** A live owned handle, slimmed to the two capabilities close() needs. */
export interface WindowHandle {
  agent: { id: string; cancel(cause: unknown): void }
  dispose(): Promise<void>
}

/** Internal store shared by the registry and the operation layer. */
export interface RegistryStore {
  entries: Map<string, WindowInfo>
  budget: number
  handles: Map<string, WindowHandle>
}

/** Create a fresh registry scoped to one plugin mount. */
export function createRegistry(maxWindows: number): RegistryStore {
  return { entries: new Map(), budget: maxWindows, handles: new Map() }
}

/** Register a newly-created window. Returns error reason string if over-budget. */
export function registerWindow(
  store: RegistryStore,
  payload: Omit<WindowInfo, 'status' | 'createdAt' | 'lastActivity'>,
): string | null {
  const count = store.entries.size
  if (count >= store.budget) {
    return `window-budget-exceeded: active windows (${count}) reached limit (${store.budget}); close one first.`
  }
  const now = Date.now()
  store.entries.set(payload.sessionId, {
    ...payload,
    status: 'idle',
    createdAt: now,
    lastActivity: now,
  })
  return null
}

/** Unregister a closed window. Returns false if never registered. */
export function unregisterWindow(store: RegistryStore, sessionId: string): boolean {
  return store.entries.delete(sessionId)
}

/** Update status of an existing window (observation only — no activity bump). */
export function updateStatus(store: RegistryStore, sessionId: string, status: WindowInfo['status']): void {
  const info = store.entries.get(sessionId)
  if (info !== undefined) info.status = status
}

/** Touch last activity without changing status. */
export function touchActivity(store: RegistryStore, sessionId: string): void {
  const info = store.entries.get(sessionId)
  if (info !== undefined) info.lastActivity = Date.now()
}

/** Return a shallow array of window snapshots (pure data, no live refs). */
export function listAll(store: RegistryStore): ReadonlyArray<WindowInfo> {
  return [...store.entries.values()]
}

/** Return the active count of windows. */
export function activeCount(store: RegistryStore): number {
  return store.entries.size
}

/** Ownership guard: returns an error code if caller does not own target. */
export function assertOwned(
  store: RegistryStore,
  sessionId: string,
  callerSessionId: string,
): 'window-not-found' | 'window-not-owned' | null {
  const info = store.entries.get(sessionId)
  if (info === undefined) return 'window-not-found'
  if (info.owner !== callerSessionId) return 'window-not-owned'
  return null
}

/** Stash the owned handle (for close). */
export function setHandle(store: RegistryStore, handle: WindowHandle): void {
  store.handles.set(handle.agent.id, handle)
}

/** Retrieve and remove the handle for a window. */
export function takeHandle(store: RegistryStore, sessionId: string): WindowHandle | undefined {
  const handle = store.handles.get(sessionId)
  if (handle !== undefined) store.handles.delete(sessionId)
  return handle
}
