# @deepseek-ai/dsh-window-session

English | [中文](README.zh.md)

Model-facing tools that let a scheduling agent create, drive, read, and close ordinary window sessions — without subagent overhead or `origin:'subagent'` restrictions. The package registers five tools (`window_create`, `window_read`, `window_send`, `window_status`, `window_close`) plus a concise system-prompt guidance section. Shipped host compositions do not mount it by default.

## Configuration

| Key | Default | Meaning |
|---|---:|---|
| `maxWindows` | **5** | Maximum concurrent child windows (budget gate enforced at `window_create`) |
| `toolTimeoutMs` | 180000 | Cooperative timeout budget per tool call in milliseconds |

### Tool overview

| Tool | Purpose | Key behaviour |
|---|---|---|
| `window_create` | Spawn a child session with a preset / model | Resolves model via `llm.resolveCallConfig`; installs `installModelSelection` ref + preset composition; optionally queues an initial task card as the first user message |
| `window_read` | Fetch the child's current or final model surface as compact text | Reads via `sessionQuery.readSurface()` whether the child is running or idle; folds `user/message`, `assistant/message`, `tool/result` events; falls back to status-only when unreadable |
| `window_send` | Push a follow-up or steering message into a child turn | Validates ownership guard; calls `agent.followup()` or `agent.steer()` directly |
| `window_close` | Stop the child, optionally archive it, and release the budget slot | With `archive: true`, persists the archive through `workspaceRegistry` before calling `cancel('closed-by-tool')` + `handle.dispose()`; close failures are returned and keep the registry entry for retry |
| `window_status` | List all tracked windows with id/preset/model/status | Refreshes live statuses from `ctx.agents.get()` before returning snapshot |

All tools return JSON-text values (rendered via `TEXT_OUTPUT`). No structured output or presentation hooks are active for M0.

## Security & Ownership Guard

Each window is registered with the caller's session id as `owner`. `window_send` and `window_close` verify the target belongs to the calling session; violations are rejected with `window-not-owned`. This mirrors the `hasSubagentOwner → agent-busy` pattern used by the api-proxy for subagent sessions.

The concurrency limit N is a hard gate in the plugin's in-memory registry — `window_create` fails with `window-budget-exceeded` when the active count would exceed N. Windows released via `window_close` free their slot immediately.

## Lifecycle Guarantee

Child windows are created through `ctx.agents.create(options)` where the owner context is the `agents` registry root (not the calling plugin fiber). This means:

- Stopping or updating this plugin does **not** destroy live child windows.
- Child sessions remain visible in the GUI session list and are fully usable even when the plugin is unloaded.

## Design Document

See [`DESIGN.md`](./DESIGN.md) for the full design specification including S0 spike conclusions and implementation blueprint.

## Model Experience

### System prompt

#### What the model sees

The mounted plugin adds the following stable guidance to the scheduling agent's system prompt:

##### System prompt guidance

```markdown
Use window_create to launch a new child window session with a specific preset. Monitor progress with window_read after each step. Use window_send to dispatch follow-up instructions or steer an active turn. Use window_status to see all active windows at once. Use window_close when a child finishes its work to free a slot. At most one concurrent window per budget unit.
```

#### Token effect

One fixed ~90-token section present on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the plugin definition and guidance text remain unchanged.

## Known Limitations and Deferred Work

- Shipped host compositions do not mount the concurrent window tools by default; a host must explicitly select or copy the example preset. A client monitoring panel and durable registry recovery after plugin reload remain deferred.
