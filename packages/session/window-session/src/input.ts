/**
 * Parameter schemas for all five tools, structured as plain JSON-schema objects.
 *
 * This mirrors the pattern used by `tool-session-query/src/input.ts`:
 * constant objects annotated with `{ readonly }` fields for readability.
 */

const TARGET_SESSION_PARAM = {
  sessionId: { type: 'string', description: 'Target child-window session id.' },
} as const

export const windowCreateParameters = {
  // The agent preset to compose the child from (e.g., "minimal" for 极简模式).
  preset: { type: 'string', required: true, description: 'Agent preset id applied to the new child window.' },
  // Optional explicit model routing overrides the window\'s default.
  provider: { type: 'string', description: 'LLM provider route. Omit for auto-resolve.' },
  model: { type: 'string', description: 'Target model id. Omit for default.' },
  reasoningEffort: { type: 'string', description: 'Reasoning-effort level ("low", "medium", "high"). Omit for default.' },
  // Workspace override — defaults to the caller\'s cwd if omitted.
  cwd: { type: 'string', description: 'Working-directory path for the child. Omit for caller cwd.' },
  // Initial task instructions — if omitted, the child is created idle.
  taskCard: { type: 'string', description: 'Markdown task-card text injected as the first user message.' },
} as const

export const windowReadParameters = {
  ...TARGET_SESSION_PARAM,
  // How many recent surface events to fold into the digest.
  tailEvents: { type: 'integer', minimum: 1, maximum: 50, description: 'Max surface events in returned digest. Defaults to 20.' },
} as const

export const windowSendParameters = {
  ...TARGET_SESSION_PARAM,
  text: { type: 'string', required: true, description: 'Message text to deliver to the child.' },
  steer: { type: 'boolean', description: 'If true, send as steering (interrupt current turn); otherwise queue as follow-up.' },
} as const

export const windowCloseParameters = {
  ...TARGET_SESSION_PARAM,
  archive: { type: 'boolean', description: 'If true, archive the session via workspace registry before closing.' },
} as const

export const windowStatusParameters = {} as const
