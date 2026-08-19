/**
 * Parameter schemas for all five tools, structured as plain JSON-schema objects.
 *
 * This mirrors the pattern used by `tool-session-query/src/input.ts`:
 * constant objects annotated with `{ readonly }` fields for readability.
 */

const TARGET_SESSION_PARAM = {
  sessionId: { type: 'string', required: true, description: 'Target child-window session id.' },
} as const

/** JSON schema for creating a child window. */
export const windowCreateParameters = {
  // The ability level marker: "l1" | "l2" | "l3" (阻塞升级标记). The plugin
  // expands it from the configured levels table (preset/provider/model/effort).
  level: { type: 'string', description: 'Ability level marker ("l1" | "l2" | "l3"); expanded from the configured levels table.' },
  // Agent preset id applied to the new child window; overrides the level's preset.
  preset: { type: 'string', description: 'Agent preset id applied to the new child window. Omit to use the level preset.' },
  // Optional explicit model routing overrides the level's model pair.
  provider: { type: 'string', description: 'LLM provider route. Omit for the level (or default) provider.' },
  model: { type: 'string', description: 'Target model id. Omit for the level (or default) model.' },
  reasoningEffort: { type: 'string', description: 'Reasoning-effort level ("low", "medium", "high"). Omit for the level default.' },
  // Workspace override — defaults to the caller\'s cwd if omitted.
  cwd: { type: 'string', description: 'Working-directory path for the child. Omit for caller cwd.' },
  // Initial task instructions — if omitted, the child is created idle.
  taskCard: { type: 'string', description: 'Markdown task-card text injected as the first user message.' },
} as const

/** JSON schema for reading a child window surface. */
export const windowReadParameters = {
  ...TARGET_SESSION_PARAM,
  // How many recent surface events to fold into the digest.
  tailEvents: { type: 'integer', description: 'Max surface events in returned digest. Defaults to 20.' },
} as const

/** JSON schema for sending a message to a child window. */
export const windowSendParameters = {
  ...TARGET_SESSION_PARAM,
  text: { type: 'string', required: true, description: 'Message text to deliver to the child.' },
  steer: { type: 'boolean', description: 'If true, deliver as steering (takes effect at the next step boundary); otherwise queue as follow-up.' },
  interrupt: { type: 'boolean', description: 'If true, abort the child\'s current step/tool call now and deliver immediately (true interrupt); use when the child is stuck in a long-running call and needs a prompt.' },
} as const

/** JSON schema for closing and optionally archiving a child window. */
export const windowCloseParameters = {
  ...TARGET_SESSION_PARAM,
  archive: { type: 'boolean', description: 'If true, archive the session via workspace registry before closing.' },
} as const

/** JSON schema for listing tracked child windows. */
export const windowStatusParameters = {} as const
