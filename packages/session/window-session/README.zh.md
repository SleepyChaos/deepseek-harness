# @deepseek-ai/dsh-window-session

[English](README.md) | 中文

面向调度 Agent 的模型工具包：让主 Agent 创建、驱动、读取和关闭普通窗口会话，无需 subagent 的 `origin:'subagent'` 限制。注册五个工具（`window_create` / `window_read` / `window_send` / `window_status` / `window_close`）以及一条系统提示引导段落。宿主组合不默认挂载。

## 配置项

| 键 | 默认值 | 含义 |
|---|---:|---|
| `maxWindows` | **5** | 最大并发子窗口数（预算闸在 `window_create` 时硬拦截） |
| `toolTimeoutMs` | 180000 | 每个工具调用的协作超时预算（毫秒） |

### 工具概览

| 工具 | 作用 | 关键行为 |
|---|---|---|
| `window_create` | 使用预设/模型派生子会话 | 通过 `llm.resolveCallConfig` 校验模型；安装 `installModelSelection` 选择引用 + 预设挂载；可选注入首条任务卡 |
| `window_read` | 读取子窗口的当前模型面为紧凑文本 | 通过 `sessionQuery.readSurface()` 拉取并折叠事件（user/assistant/tool-result）；不可读时降级为状态报告 |
| `window_send` | 向子窗口追加 follow-up 或 steer | 归属校验；调用 `agent.followup()` 或 `agent.steer()` |
| `window_close` | 停止子窗口、释放预算槽位 | `cancel('closed-by-tool')` + `handle.dispose()`；从注册表移除 |
| `window_status` | 列出所有已跟踪窗口的摘要 | 刷新实时状态后返回快照 |

所有工具以 JSON 文本形式返回结果。M0 阶段不使用结构化输出或 UI 呈现钩子。

## 安全与归属校验

每个子窗口注册时使用调用方的 session id 作为 `owner`。`window_send` 和 `window_close` 要求目标窗口归属于调用者；否则以 `window-not-owned` 拒绝。此模式对标 api-proxy 中 subagent 的 `hasSubagentOwner → agent-busy` 语义。

并发上限 N 是插件内存注册表的硬性闸：`window_create` 超限时以 `window-budget-exceeded` 失败；`window_close` 立即释放槽位。

## 生命周期保障

子窗口通过 `ctx.agents.create(options)` 创建，其 owner context 是 agents 注册表的根上下文（而非调用方 fiber）。因此：

- 停止或更新本插件不会销毁运行中的子窗口。
- 子会话始终可见于 GUI 会话列表，即使插件卸载也可继续使用。

## 模型体验

### 系统提示

#### 模型看到的内容

```markdown
Use window_create to launch a new child window session with a specific preset. Monitor progress with window_read after each step. Use window_send to dispatch follow-up instructions or steer an active turn. Use window_status to see all active windows at once. Use window_close when a child finishes its work to free a slot. At most one concurrent window per budget unit.
```

#### Token 影响

每请求一行固定约 90 token 的引导段，插件挂载期间持续生效。

### KV Cache 影响

插件定义和引导文本不变时前缀稳定。

## 设计文档

参见 [`DESIGN.md`](./DESIGN.md)，包含完整的 Spike S0 结论和实现蓝图。
