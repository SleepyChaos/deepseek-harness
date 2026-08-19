# dsh-window-session 插件 —— 设计草案 v0.2（S0 已解决）

> 配套：《DESIGN_并发Agent预设方案.md》（v0.2）· 目标环境：DeepSeek Harness（DSH）Web GUI 本文档交付 **`dsh-window-session` 插件的设计与实现蓝图**：让「并发模式」主 Agent 获得创建普通窗口会话（子 Agent）、通信介入、监控读取、任务分发四项能力。 状态：**S0 已解决（§13）**，实现蓝图已定（§14）；**M0-A 完成**（五工具编译通过 + 单测通过）， **M0-B 插件边界集成测试完成**（mock 边界服务挂载五工具，10/10 测试通过）；真机 agent-loop 验证留待 M1。 **M1 并发业务层设计草案已完成（§15）**：预设组合骨架 + 调度协议 + 状态机 + 编排提示词； **并发模式 preset 已落盘并通过 `standingKeyFor` 挂载校验**（§15.7）。 **B/C/D 已完成（§16）**：真实边界集成测试（真实 AgentRegistry + 真实 session-query）、 队列收敛冒烟（8 任务 × 5 槽）、live lastActivity（session/event 订阅）；D2 客户端面板 因 preset 行不进浏览器 boot 图而范围外（架构结论，留 M2）。 实现进度见 §12。 实现形态修正：本插件落地为 DSH monorepo 的一个**真实 Host 包** `@deepseek-ai/dsh-window-session`（`packages/session/window-session/`）， 而非一次性动态插件；随宿主组合挂载、随仓库提交演进（见 §14.4）。

---

## 1. 定位与范围

### 1.1 插件在整个方案中的角色

v0.2 方案里主 Agent 是调度中心、子 Agent 是普通窗口会话，两者之间的唯一控制面 就是本插件。本插件的设计原则是 **插件只提供"原语"，不承载业务**：

| 层 | 职责 | 归属 |
|---|---|---|
| 原语层（本插件） | 建窗 / 送消息 / 读窗 / 关窗 / 状态汇总 / 并发预算闸 | `dsh-window-session` |
| 业务层 | 任务队列、分批、能力梯度升级、flag 提交、WP 汇总 | 主 Agent 预设（prompt）+ `board/` md 文档 |

业务层已在 v0.2 §5–§8 设计完毕，本插件不重复实现，只向主 Agent 暴露最小工具面。

### 1.2 与 v0.2 的一处关键修正：实现平面

v0.2 §4.3 与附录 C 提出在 **client-plugin 层** 复用 `session.create` 等 RPC 建窗。 本次草案基于源码核查修正为：

> **主实现平面为 Host 半区**（动态 Cordis 插件，宿主进程内直接组合 DSH 现有 Services），Client 半区仅作可选的可视化面板。理由见 §2、§9。

修正动机（均有源码依据）：

1. **宿主进程已有全部能力**：`agents.create` / `agentLoop` / `agentPresets` / `sessionQuery` / `sessionPersistence` / `session/event` 事件均为 Host 侧 Service 或 Event，Host 半区可直接组合，**不依赖浏览器页面存活**（子窗口在宿主进程里照常 运行，GUI 只是查看器）。
2. **与 GUI 行为完全同源**：GUI 的 `session.create` RPC 内部就是 `ctx.agents.create({sessionId, agentOptions, meta:{cwd, agentPreset}, setup})` （api-proxy `ensureSession`），Host 半区复用同一入口，产物与用户手建窗口无异。
3. **审批策略天然保留**：该入口不设 `origin:'subagent'`，子窗口使用自身预设的 审批策略，需要批准的操作照常询问用户（v0.2 §1.2 的核心诉求，直接兑现）。

Client 半区仍可选，用于在 GUI 内渲染「窗口监控面板」（§9.2）。

### 1.3 非目标

- 不做任务队列/分批/升级的业务实现（v0.2 §5–§8 已有方案，由主 Agent 承担）。
- 不修改 DSH 内核或 host 组合（本插件只注册工具/事件/可选 UI，不触碰内核注册表）。
- 不做容器资源调度（容器数量 C 由用户输入，v0.2 §6.1）。

---

## 2. 已验证的地基（源码依据）

| # | 事实 | 依据（deepseek-harness 源码） |
|---|---|---|
| 1 | `session.create` RPC 语义为「创建真实会话 + 空闲 agent」，payload 支持 `cwd`/`sessionId`/`agentPreset`；会话创建后**立即出现在 GUI 会话列表** | `packages/host/apiproxy/src/api/rpc-map.ts:27`、`api/sessions.ts`（create 文档注释）、`src/api-proxy.ts:1587 ensureSession` |
| 2 | 普通会话 agent 与 subagent 的唯一区别在 `origin:'subagent'` 可选标记与 owner 归属；不设即普通窗口、保留预设审批 | `packages/core/agent/src/index.ts:80-135`（CreateAgentOptions.meta.origin?） |
| 3 | 建窗组合路径：`agents.create({sessionId, agentOptions, meta:{cwd, agentPreset}, setup})`，setup 负责挂载预设组合 | `packages/host/apiproxy/src/api-proxy.ts:1587-1690`（ensureSession） |
| 4 | 驱动子窗口=注入一条用户消息：`agent.followup(UserMessage)` / `agent.steer(UserMessage)`（等价 GUI 发送，模式 queue/steer） | `api-proxy.ts:2401`（session.prompt 实现） |
| 5 | 模型/思考强度为**会话级** ModelSelection（provider/model/reasoningEffort），GUI 经 `session.selectModel` RPC 应用 | `api/rpc-map.ts`（session.selectModel）、`api/sessions.ts`（selectModel 文档注释） |
| 6 | 读窗可选：`sessionQuery.readSession/listEvents`、`sessionPersistence.readFrom(seq)`、`session.history` RPC（按页、含 tool/思维链事件） | Host Service 目录：`sessionQuery`、`sessionPersistence` |
| 7 | 监控事件面齐全：`agent/status`、`agent/error`、`agent/turn-stopping`、`session/event`（追加流）、`agent/created|disposed` | Host Event 目录（已查询确认） |
| 8 | Host 插件可注册模型工具：`harness.registerTool(ctx, ToolDefinition)`；可注册 Package 私有 RPC：`harness.handle(method, handler)` | Host Builtin 目录（已查询确认） |
| 9 | 会话侧资格校验先例：subagent 会话拒绝外部访问用 `hasSubagentOwner(attached, live)` → `agent-busy`；本插件照此模式做「窗口归属校验」 | `api-proxy.ts`（ensureSession / session.list 中引用） |
| 10 | 窗口身份可持久化：`sessionId`（role 无关的品牌字符串）+ `~/.dsh` 会话日志 + `board/` md，可双重记录 | v0.2 §4.3、§9 |

> 结论：v0.2 §1.2 对 spawn/fork 的批判以及对「窗口会话」可行性的判断，在源码层面 全部成立；实现不需要内核改动。

---

## 3. 能力面（模型工具）

主 Agent 侧可见的模型工具（`harness.registerTool` 注册，schema 为 JSON）：

| 工具 | 参数（JSON schema） | 语义 | 对应 DSH 既有路径 |
|---|---|---|---|
| `window_create` | `{preset, provider?, model?, reasoningEffort?, cwd?, taskCard?}` | 新建一个普通窗口会话（指定预设/模型/思考强度，可选注入任务卡首条消息） | 组合 §2-3 + §2-5（解释见 §5） |
| `window_send` | `{sessionId, text, steer?}` | 向窗口注入一条用户消息（续派任务 / 介入提示 / 指挥） | `agent.followup/steer`（§2-4） |
| `window_read` | `{sessionId, tailEvents?}` | 读取窗口当前或最终模型面（工具调用/输出 + 状态），返回脱敏摘要 | `sessionQuery.readSurface`（§2-6） |
| `window_close` | `{sessionId, archive?}` | 结束窗口的运行中轮次并释放槽位；`archive:true` 先持久化归档，失败时保留条目供重试 | `agent` 轮次中止 + 生命周期（§2-7） |
| `window_status` | `{filter?}` | 汇总全部活动窗口：id / 状态 / 模型 / 最近活动 / 任务卡摘要 | 插件内 registry + `ctx.agents.list` |
| `window_set_model`（可选，v1） | `{sessionId, provider, model, reasoningEffort?}` | 运行中热切换模型/思考强度 | 会话级 ModelSelection（§2-5） |

工具名以最终实现为准；每个工具返回纯 JSON（禁止回传 Session/Agent 活对象，严守 §10.3）。

---

## 4. 会话身份与生命周期

### 4.1 身份

- **窗口身份 = sessionId**：插件不发明第二套 ID；`window_create` 由插件生成 `session-<randomUUID>`（与 GUI 建窗同格式），后续全部工具以 `sessionId` 寻址。
- **双记录**：插件内存 registry（权威，含预算/归属/状态/最近活动）+ 持久化副本 `board/registry.md`（防进程重启丢失；插件重建时从 board 恢复标记得知哪些窗口 是它创建的、仍存活）。

### 4.2 状态机

```text
created（已建窗，任务卡已注入）→ running（有轮次在跑）
  → idle（轮次结束，等派发/等介入）→ closed（window_close，槽位释放）
running/idle --超时无进展--> stalled（心跳标记，供主 Agent 轮询发现）
```

### 4.3 生命周期纪律（防增生，对应 v0.2 §6.4/§10）

1. `window_create` 在 Host 半区做**硬性预算校验**：`registry.active() + 本次 ≤ N`， 越限直接拒绝（返回 `budget-exceeded`）。
2. 升级流程沿用「先关旧窗、再开新窗」（v0.2 §7.2），保证活跃数恒定 ≤ N。
3. `window_close` 后会话记录仍在 GUI 列表中（历史可查、可人工重开）；`archive:true` 才走 `workspaceRegistry.archiveSession` 归档。

---

## 5. 创建流程（window_create）

```text
1. 预算闸：active + 1 ≤ N，否则拒绝
2. 生成 sessionId；cwd 默认取主 Agent 工作区，preset 必填（极简/标准/…）
3. 建窗：ctx.agents.create({
     sessionId,
     agentOptions,                       // 模型/effort 注入点（见 M0 spike）
     meta: { cwd, agentPreset: preset },
     setup: (agentCtx) => agentPresets.mount(agentCtx, presetId),
   })
   → 立即 announce/publish：窗口即刻出现在 GUI 会话列表（用户可点开介入）
4. 会话级 ModelSelection 应用（provider/model/reasoningEffort）—— 实现细节见 §11.sp2
5. 若给了 taskCard：构造 UserMessage，agent.followup() 注入任务卡（后续轮次队列驱动）
6. registry 登记 {sessionId, preset, model, task, owner=本主Agent, createdAt}
7. 返回 {sessionId, agentPreset, cwd}
```

主 Agent 的初始指令卡（task.md 协议）由第 5 步注入；注入后子窗口进入独立解题， 自主运行，无需主 Agent 继续介入（§8 只负责派发与回收）。

---

## 6. 通信面（window_send / 介入）

- **发送语义**：`steer:false`（默认）走 `agent.followup(UserMessage)`——排队进窗口 的消息队列，轮次自然消费；`steer:true` 走 `agent.steer()`——直接打断当前轮次 （主 Agent 发「停止、改思路」类介入）。
- **归属校验（安全闸）**：发送前校验目标窗口在本插件 registry 中且 `owner == 当前主 Agent`；不满足返回 `window-not-owned`（照搬 `hasSubagentOwner → agent-busy` 语义，防止误控他人会话）。
- **用户介入不受限**：任何用户可点开子窗口直接打字（GUI 原生能力，插件不阻止、 不拦截——这是 v0.2 §1.2 的关键特性）。

---

## 7. 监控面（window_read + 事件订阅 + 心跳）

三层并行，主 Agent 的轮询循环（v0.2 §8）可任选一层：

| 层 | 机制 | 用途 |
|---|---|---|
| 拉取 | `window_read`：`sessionQuery.readSurface(sessionId)` 读取当前或最终模型面的事件，折叠为摘要（用户/助手文本、工具调用及其结果），**不导出思维链全文**（可加 `tailEvents` 上限） | 主 Agent 轮询周期（默认 45s）取进度 |
| 事件 | 插件监听 `agent/status`、`agent/error`、`agent/turn-stopping`、`session/event` → 更新 registry 的 status/lastActivity，并可写 `board/sessions/<id>/progress.md` 的 mtime 供主 Agent 快速探测 | 免轮询的即时状态变化 |
| 心跳 | 插件 `timer.interval` 每 `heartbeatSec` 扫 registry：离 lastActivity 超
  `stallTimeoutSec` 的窗口打 `stalled` 标记并回报 | 假死检测（v0.2 §8-5） |

返回主 Agent 的状态摘要为纯 JSON：`{sessionId, status, model, lastActivity, task, tailDigest?}`。

---

## 8. 任务分发分工（插件原语 vs 主 Agent 业务）

| 业务步骤（v0.2 方案） | 执行方 | 插件角色 |
|---|---|---|
| 队列维护 / 分批（§5.2） | 主 Agent（`board/task_board.md`） | 无 |
| 派发一批 → 建窗 + 注入任务卡 | 主 Agent | `window_create`（含预算闸） |
| 完成一批 → 结算（flag 提交、WP 拼接、关窗、派下一批） | 主 Agent | `window_close` + `window_create` |
| 阻塞 → 升级（关旧窗开 L2/L3 窗，凭证注入） | 主 Agent | `window_close/create` + `window_send` |
| 假死 → 介入或回收 | 主 Agent | `window_send(steer)` / `window_close` + 心跳标记 |

插件保持无状态业务（除 registry 与预算）；窗口内协议（progress/results/blocked md） 沿用 v0.2 §9，由主 Agent 在任务卡中约束子窗口遵守。

---

## 9. Host / Client 分工

### 9.1 Host 半区（必需，控制面）

- 注册 4+1 个模型工具（§3）。
- 窗口 registry + 预算闸 + 归属校验。
- 事件订阅与心跳（§7）。
- `harness.handle('windows.list' / 'window.create' / …)` 为 Client 面板提供只含 标量的 JSON 视图（仅读取 registry 的叶字段）。

依赖（关键项 `inject`）：`tools`、`systemPrompt`、`agents`、`llm`、`sessionQuery`、 `agentPresets`；无 `subagents` 依赖。归档时可选读取 `workspaceRegistry`。

### 9.2 Client 半区（可选，可见性）

- 注册一个轻量 Slot 面板（如 Run 卡 `tool.view.cordis` 或 sidebar 内槽）， 渲染活动窗口表：id / 预设 / 模型 / 状态 / 最近活动 / 任务摘要。
- 每行提供「打开」按钮（深链到该会话，用户点入子窗口直接指挥——v0.2 差异化卖点的 可视化）。按钮跳转经 Client 既有导航能力实现，不新增 Host RPC。
- 面板数据全部来自 `host.call('windows.list')` 的纯 JSON。

---

## 10. 安全与约束

| 约束 | 设计 |
|---|---|
| 并发上限 N | Host 半区硬性预算闸（§4.3）；升级先关后开 |
| 误控他人会话 | 窗口归属校验（§6）；不拥有 owner 的 sessionId 一律拒绝 |
| 审批策略 | 不设 subagent 标记 → 子窗口保留预设审批，用户在子窗口内可批（v0.2 §1.2、§11.1） |
| 活数据边界 | 工具/面板只回标量 JSON；Session/Agent 对象永不出插件边界（技能红线） |
| 生命周期可逆 | 全部订阅/工具/定时器挂在插件 Fiber（ctx.on/effect 与 disposer），stop/update 自动卸载；**子窗口本身不应随插件 fiber 销毁**（见 §11.sp4） |
| 子窗口自主性 | 子窗口无本插件的建窗工具（极简 preset 不含），只能解题交付（v0.2 §1.2 选择它的原因） |

---

## 11. S0 spike 结论总览（全部已解决）

> 5 个实现细节在源码层全部钉死，无遗留风险项；详细证据与方案见 §13。

| id | 待确认项 | 结论 | 证据锚点 |
|---|---|---|---|
| sp1 | 会话级 ModelSelection 如何注入 | **进程内直接注入，不走 RPC**：setup 里调 `installModelSelection(agentCtx, ref)` + `agentPresets.mount(agentCtx, presetId)`；`ref.current` 返回目标 `{provider, model, reasoningEffort}` | §13.1 · `installModelSelection`（dsh-agent/model-selection.ts）、`selectionFor`（api-proxy.ts:1123）、selectModel（api-proxy.ts:2222） |
| sp2 | 非 GUI 驱动 `agent.followup()` | **可行**：`agent.followup(UserMessage)` 即 `session.prompt` 内部路径；用 `createUserMessage({content, source:{kind:'user'}})` 构造 | §13.2 · prompt 实现（api-proxy.ts:2401）、`Agent.followup/steer/cancel/whenIdle`（dsh-agent runtime-types） |
| sp3 | 模型路由校验 | **建窗前校验**：`ctx.llm.resolveCallConfig({provider, model, reasoningEffort})`（未知模型抛错、规范化输出），与 selectModel 同款 | §13.3 · selectModel（api-proxy.ts:2222） |
| sp4 | 子窗口与插件 fiber 生命周期解耦 | **天然解耦**：`agents.create` 的 `ownerCtx = this.ctx`（AgentRegistry 根上下文），**非调用方 fiber**；子窗口是顶层根会话，插件 stop/update 不会销毁它 | §13.4 · `AgentRegistry.create`（dsh-agent index.ts）、AgentHandle 注释 |
| sp5 | `window_read` 摘要折叠 | **用 `sessionQuery.readSurface` 拿当前模型面**（user/message、assistant/message、tool/result 顺序事件），只取叶字段折成文本 | §13.5 · readSurface / SessionSurfaceSnapshot（dsh-session-query/types.ts）、SessionEventMap（dsh-session types.ts） |

---

## 12. 里程碑与验收（对齐 v0.2 §13 的 M0/M1）

| 里程碑 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| S0 spike | 上述 sp1–sp5 | 5 项都有明确结论 | ✅ 已提交（`5874f94449`） |
| 脚手架 | 真实 Host 包 `@deepseek-ai/dsh-window-session` + 五工具注册 + tsconfig 引用 | 包纳入仓库、lint/typecheck 通过 | ✅ 已提交（`5874f94449` + `5ea4bcf031`） |
| M0-A 建窗 | `window_create` + `window_read` 闭环 + 预算闸/归属 + 单测 | 五工具 `tsc -b` EXIT 0；`vitest` 5/5 通过 | ✅ 已提交（`cd1df76561`） |
| M0-B 集成验证 | `window_send`(steer)/`window_status`/`window_close` 真机验证 | 在真实 host + agent-loop + 模型下建窗/续派/介入/关窗全通 | 🟡 插件边界集成 ✅（mock 边界服务挂载五工具：注册/建窗/状态/续派/模型路由/归属拒绝/预算/关窗 5 例全通，`vitest` 10/10）；真机验证留待 M1 |
| M1 并发业务 | 接上主 Agent 队列/升级/提交（v0.2 M1/M2） | 活跃窗口恒 ≤ N；C=1+4 两队列收敛 | 🟡 业务层设计完成（§15）+ preset 落盘挂载校验 ✅ + **B 真实边界 ✅ / C 队列收敛冒烟 ✅ / D1 live lastActivity ✅（§16）**；真机竞赛场景验证留待你（M1.2） |

> 注：`window_create`/`window_send`/`window_close`/`window_status` 的完整逻辑在 S0/M0-A 阶段已一并写入 `src/operations.ts`；纯逻辑（预算闸、归属校验、digest 折叠）与插件边界 集成（`tests/core.spec.ts` + `tests/tools.spec.ts`，共 10 例）均有测试覆盖。 真机集成验证需要完整 host 组合 + 模型适配器 + agent-loop，留待 M1。 附带修正（M0-B 集成测试暴露）：`tailEvents` 不再使用 `minimum/maximum` （value-schema DSL 不支持）；预算闸提前到 create 之前（避免先建后销毁）。

---

## 13. S0 spike 详细证据与方案

> 全部结论来自对 `deepseek-harness` 源码的直接阅读；行号对应当前 checkout `feat/full-url-api-endpoint`（S0 提交点）。

### 13.1 sp1 —— 会话级 ModelSelection 注入（已定）

**证据**：
- api-proxy 建窗路径 `ensureSession`（api-proxy.ts:1587）：`ctx.agents.create({sessionId, agentOptions, meta:{cwd, agentPreset}, setup})`。`setup` 由 `composeAgent`（api-proxy.ts:1196）产出——先 `installSelection(agentCtx)`（= `installModelSelection`），再 `agentPresets.mount(agentCtx, presetId)`。
- `selectionFor`（api-proxy.ts:1123）用 `WeakMap<Agent, ModelSelectionRef>` + `agent.session.requestHeader()?.config` 三级回落：进程内选择 > 会话日志最新请求头 > 全局默认。
- `installModelSelection(agentCtx, selection)`（`@deepseek-ai/dsh-agent`，model-selection.ts）把选择挂到两个 waterfall：`system-prompt/assemble`（注入 provider/model 变量）与 `agent/request`（覆盖 provider/model/reasoningEffort）。返回 disposer。
- `selectModel` RPC（api-proxy.ts:2222）= `selectionFor(agent).current = selected` + `defaults.saveDefaultModelSelection`。

**方案**：M0 不走 RPC。在 `window_create` 的 `setup` 回调里，复刻 GUI 路径：
```ts
declare const fixedSelection: unknown
declare const presets: { mount(ctx: unknown, id: string): Promise<void> }
declare const presetId: string
declare function installModelSelection(ctx: unknown, selection: { current: unknown; assembled: undefined }): void
setup: async (agentCtx: unknown) => {
  installModelSelection(agentCtx, { current: fixedSelection, assembled: undefined })
  await presets.mount(agentCtx, presetId)
}
```
其中 `fixedSelection = {provider, model, reasoningEffort?}` 是目标组合。 **不写全局默认**（避免把子窗口模型泄漏为全局），只落会话级。

### 13.2 sp2 —— 非 GUI 驱动窗口（已定）

**证据**：
- `session.prompt`（api-proxy.ts:2401）= `agent.followup(UserMessage)` / `agent.steer(UserMessage)`，其中 `message = createUserMessage({ content, source })`，`source = { kind: 'user', rpcId, ... }`。
- `Agent` 接口（dsh-agent runtime-types.d.ts）：`followup(message)`、`steer(message)`、 `inject(message)`、`cancel(cause, options?)`、`whenIdle()`、`readonly status`、`readonly session`、`readonly ctx`。
- `createUserMessage`（`@deepseek-ai/dsh-llm`）= 构造并深冻结一条 `role:'user'` 消息； `MessageSourceMap.user = { kind: 'user' }`。

**方案**：
```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
declare const text: string
declare const steer: boolean
declare const agent: { steer(message: unknown): void; followup(message: unknown): void }
const message = createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
if (steer) agent.steer(message); else agent.followup(message)
```
`window_close` 用 `agent.cancel(cause)` 停轮次 + `handle.dispose()` 注销并摘除会话 （持久日志由 `sessionPersistence` 保留，GUI 历史可查）。

### 13.3 sp3 —— 模型路由校验（已定）

**证据**：`selectModel`（api-proxy.ts:2222）在建窗/切模型前调 `ctx.llm.resolveCallConfig({provider, model, reasoningEffort?})`，未知模型抛错并规范化； `turnAgentFor`（api-proxy.ts:1819）在 prompt 前用 `routeServed(selection.provider)` 拒 `model-unavailable`。

**方案**：`window_create` 先 `await ctx.llm.resolveCallConfig({...})` 校验并拿到规范化的 `{provider, model, reasoningEffort}`，失败即拒绝建窗（返回 `model-unavailable`）。

### 13.4 sp4 —— 子窗口与插件 fiber 生命周期（已定，天然解耦）

**证据**：
- `AgentRegistry.create(options)`（dsh-agent index.ts）：
  ```ts
  declare const registryCtx: unknown
  declare const target: { createAgent: (...args: any[]) => unknown }
  declare const receiver: object
  declare const options: unknown
  function create() {
    const ownerCtx = registryCtx   // 注册表服务的根上下文，非调用方 fiber
    return Reflect.apply(target.createAgent, receiver, [ownerCtx, options])
  }
  ```
- `AgentHandle` 注释：`dispose()` 停轮、注销、移除会话、回收 scope；`ctx.agents.get(id)` 仍返回裸 `Agent`，句柄只给创建者持有。
- `insert` 的 owner 记为 `this.ctx.agent`，对顶层建窗为 `undefined` → 子窗口是**根会话** （`agents.roots()` 可见），与 GUI 建窗同权。

**结论**：用 `ctx.agents.create(options)` 建窗，其生命周期由 agents 注册表根上下文持有， **不随本插件 fiber 的 stop/update 销毁**——插件可任意停更，窗口照常运行；这正是 §10 「子窗口不随插件 fiber 销毁」约束的天然实现。

### 13.5 sp5 —— window_read 摘要折叠（已定）

**证据**：
- `sessionQuery.readSurface(sessionId)` → `SessionSurfaceSnapshot { session, capturedThroughSeq, events: SurfaceEvent[] }` （dsh-session-query/types.ts）：当前模型面、按历史序的克隆事件，**live-preferred**（活的读内存、冷的读持久化）。
- `SurfaceEventType = 'user/message' | 'assistant/message' | 'tool/result'`（dsh-session types.ts）。
- 事件 data：`user/message` = `UserMessage`；`assistant/message` = `{turn, step, message: AssistantMessage, usage?}`；`tool/result` = `{turn, step, message: ToolResultMessage, error?, meta?}`。

**方案**：`window_read` 取 `readSurface(sessionId).events`，按类型折成紧凑文本（用户文本、 助手文本、工具调用/结果），只取叶字段（content 里的 text / tool name / 是否错误）， 限制返回字符量；不导出思维链全文。状态来自 `agent.status`（idle/running）。

---

## 14. 实现蓝图（包位置 / 文件 / 注册模式）

### 14.1 包位置与命名

- 路径：`packages/session/window-session/`
- 包名：`@deepseek-ai/dsh-window-session`
- 版本：`0.1.0-rc.7`（对齐 workspace）
- 类型：Host-only 模型工具包（先例：`packages/session-query/tool-session-query`）

### 14.2 文件布局

```text
packages/session/window-session/
├── package.json
├── tsconfig.json            # extends ../../../tsconfig.base.json，references 见 §14.3
├── README.md / README.zh.md # 与 tool-session-query 同结构
├── DESIGN.md                # 本设计草案（随开发维护）
└── src/
    ├── index.ts             # Cordis 插件入口：name / inject / Config(schemastery) / apply
    ├── input.ts             # 各工具参数 JSON-schema
    ├── registry.ts          # 窗口注册表：预算闸、归属、状态、handle 存根
    ├── operations.ts        # create/read/send/close/status 业务编排（结构化服务类型）
    └── digest.ts            # readSurface 事件 → 紧凑文本
    ## Config 折叠进 index.ts（导出 interface Config + const Config schema）；
    ## presentation.ts 在 M0 缺省（generic 工具卡渲染足够）
```

### 14.3 依赖与 tsconfig references

- `inject = ['tools', 'systemPrompt', 'agents', 'llm', 'sessionQuery', 'agentPresets']`（硬依赖）； `workspaceRegistry` 用 `ctx.get('workspaceRegistry')` 可选读取。
- `dependencies`：`@deepseek-ai/schemastery`（配置 schema）。
- `peerDependencies` / `devDependencies`：`cordis`、`dsh-agent`（installModelSelection、Agent 类型）、`dsh-llm`（createUserMessage、ContentBlock、ModelSelection）、`dsh-session` （SessionId）、`dsh-session-query`（readSurface）、`dsh-tools`（defineTool、ToolRunContext）、 `dsh-system-prompt`（guidance section 类型）、`dsh-timeout`（MAX_TIMER_DELAY_MS）。
- `tsconfig.references`：`vendor/cordis`、`vendor/schemastery`、`llm/llm`、`core/agent`、 `core/session`、`core/tools`、`core/system-prompt`、`session-query/session-query`、`util/timeout`。

### 14.4 挂载方式

- 作为**真实 Host 包**：由「并发模式」主 Agent 的 preset `cordis.yml` 以 `- window-session` 行挂载（`isolate` 或普通 row 视作用域需要）；随宿主进程加载，随仓库提交演进。
- 与一次性动态插件（cordis_define）的区别：真实包进仓库、可被 lint/typecheck/test、可 被多个 preset 复用；动态插件只活在当前进程。本需求（长期调度能力）选真实包。
- 子窗口预设（极简）**不挂载**本包，因此子窗口不会递归建窗（防增生，见 §10）。

### 14.5 工具契约（M0）

| 工具 | 参数 | 返回（TEXT_OUTPUT 文本） |
|---|---|---|
| `window_create` | `preset:string`、`provider?`、`model?`、`reasoningEffort?`、`taskCard?:string`、`cwd?` | `{sessionId, agentPreset, cwd, model, status}` 摘要 |
| `window_read` | `sessionId:string`、`tailEvents?:integer` | 当前或最终状态 + 最近 N 条面事件的紧凑文本 |
| `window_send` | `sessionId:string`、`text:string`、`steer?:boolean` | `{accepted:true}` |
| `window_status` | `filter?:string` | 全部活动窗口表（id/preset/model/status/task） |
| `window_close` | `sessionId:string`、`archive?:boolean` | `{closed:true, sessionId}`；归档或销毁失败返回错误并保留条目 |

`systemPrompt` guidance section（精简版）：告知模型「window_create 建窗并注入任务卡； window_read 轮询进度；window_send 续派/介入；window_close 回收；window_status 看全局」， 并声明预算上限 N。

### 14.6 预算闸与归属（M0-B）

- `registry`：`Map<sessionId, {owner, preset, model, task, createdAt, lastActivity}>`； `create` 前校验 `activeCount + 1 ≤ config.maxWindows`（默认 5），越限抛 `window-budget-exceeded`。
- 归属：`owner = exec.agent?.session.id`（调用方主会话）；`send/close` 要求目标在 registry 且 `owner` 匹配，否则抛 `window-not-owned`。
- `lastActivity`：由 `window_read`/`session/event`（M0 可选订阅）更新，供假死判定。

---

## 15. M1 并发业务层设计（主 Agent 预设 + 调度协议）

> 配套：《DESIGN_并发Agent预设方案.md》§5–§10（队列模型 / 并发调度 / 能力梯度 / 调度循环 / md 协议 / 会话生命周期）。本节约束五工具与「并发模式」主 Agent 的接法， 是 M0 插件能力之上的**业务编排层**设计。

### 15.1 目标与范围

把五个窗口工具接入「并发模式」主 Agent，实现 C=1+4 批次调度（1 容器槽 + 4 静态槽， 总活跃窗口 N=5）、能力梯度 L1→L2→L3 逐级升级、批次完成即提交回收。产出物三件：

1. 并发模式 preset 组合骨架（`agent.cordis.yml`，§15.2）；
2. 工具 ↔ 业务循环映射与状态机（§15.3–15.4）；
3. 编排提示词草案（§15.5）。

插件层（M0 已完成）提供硬约束：预算闸 `active ≤ maxWindows`、归属校验、模型/effort 路由；M1 只负责**编排纪律**，不重复实现安全边界。

### 15.2 并发模式 preset 组合骨架

```yaml
# 并发模式 agent.cordis.yml（M1 草案；从 standard 拷贝演进）
- id: window-session                # 本包：五工具 + 引导（§14.5）
  name: '@deepseek-ai/dsh-window-session'
  config:
    maxWindows: 5                   # N = 1 容器槽 + 4 静态槽
    toolTimeoutMs: 180000

# 其余行沿用 standard 的宿主消费行（bash/editor/jobs/goal/...），
# 均不发布服务 → 普通 row，不 isolate（与 skill 平面规则一致）。
```

组合要点：

- **本包只消费不提供服务**（消费 `tools/systemPrompt/agents/llm/sessionQuery`）， 因此是普通 row，**不需要** `isolate` realm。
- **子窗口 preset（极简）绝不挂载本包**：子窗口因此没有 `window_*` 工具， 从工具面杜绝递归建窗（防增生，见 §10）。
- `board/` 文档协议不需要额外行（共享文件系统工作区，v0.2 §9）。
- 若 M2 需要向其他 Agent 暴露编排状态服务，再引入 `isolate` realm 包裹。

### 15.3 调度协议（工具 ↔ 业务循环映射）

| 循环步骤（v0.2 §8） | 工具 | 说明 |
|---|---|---|
| 初始派发（开局） | `window_create` × (C + 4) | 注入 `task.md` 任务卡（§9.3）；model/effort 按 L1 组合 |
| 周期盘点 | `window_status` | 一次取全部活动窗口（id/preset/model/status/task） |
| 进度核对 | `window_read` | 对 running 窗口拉 surface 摘要，与 `progress.md` 比对 |
| 介入 / 续派 / 假死唤醒 | `window_send` | 追加指令（followup）或 `steer:true` 打断当前 turn |
| 升级 | `window_close` + `window_create` | **先关后开**；`blocked/<题>.md` 凭证经 taskCard 注入 |
| 完成回收 | `window_close` | 结算（flag 提交 + WP 并入 WRITEUP.md）后关闭，释放槽位 |

### 15.4 队列 / 升级 / 提交状态机

- 窗口生命周期：`created → running → {done | blocked_l1 | blocked_l2 | stalled} → closed`
- 题目状态（权威在 `board/task_board.md`）： `queued / assigned / in_progress / blocked_l1 / blocked_l2 / done / abandoned`
- 升级阶梯（v0.2 §7.1）：L1 `deepseek-v4-flash-0731` + 极简 → L2 `deepseek-v4-pro-0813` + 标准(high) → L3 `ZHIPU/GLM-5.3` + 标准(最高)。经 `window_create` 的 `preset / provider / model / reasoningEffort` 参数下发（sp1 已定，真能力而非近似）。
- 升级触发：子 Agent 回报 `blocked_l1` → 主 Agent 关旧窗开 L2 窗续解；L2 再阻塞升 L3。 升级窗口不再回退到 L1。
- 容器任务特殊：阻塞 → 关窗 + 回收容器（`recover-exercise-env`）→ 批次回容器队列末尾 （不立即占高能力槽）；**二次阻塞**才升级。
- 不变式：① `active ≤ N`（插件硬闸 + 主 Agent 纪律双保险）；② **close 先于 create**； ③ **完成即 close**，窗口绝不复用到别题（杜绝上下文污染）。

### 15.5 编排提示词草案（PROMPT_TEXT v2）

```text
你是「并发模式」调度主 Agent，通过窗口会话并行消化题目队列。

纪律（硬约束，违反会导致插件拒绝或调度失效）：
- 活跃窗口上限 N=5（1 容器槽 + 4 静态槽）；window_create 前先核对 window_status。
- 升级必须 window_close 旧窗口后再 window_create 新窗口（先关后开）。
- 子窗口完成或升级后立即 window_close，绝不复用窗口到别题。

调度循环（每 30–60s 一轮）：
1. window_status 盘点全部窗口。
2. 对 running 窗口 window_read 核对进度（对照 board/sessions/<id>/progress.md）。
3. 完成 → 结算：子 Agent 只交 results.md（flag + WP 片段），主 Agent 统一
   answer-panel/answer 提交 + 并入 WRITEUP.md + 更新 task_board.md → window_close。
4. blocked_l1/blocked_l2 → 升级流程（§15.4）：close → create（L2/L3，注入 blocked 凭证）。
5. >10min 无进展 → 判定假死：window_send 询问或关闭重开。
6. 队列空且无 running → 结束调度，输出最终汇总。

容器任务：isNeedInit=true 的题走容器槽；阻塞先回收容器、批次回队尾，二次阻塞再升级。
子窗口无权提交 flag，也无权再建窗口（其 preset 不含 window_* 工具）。
```

### 15.6 验收标准与风险

| 验收项 | 判定 |
|---|---|
| 窗口恒 ≤ N | 任一时刻 `window_status.active ≤ 5`（插件硬闸兜底） |
| 两队列收敛 | 队列空且无 running 时输出汇总；无窗口悬挂 |
| 升级路径 | `blocked_l1` 凭证 → L2 窗口续解 → `done`（可审计：blocked 文档 + 新窗口 task.md） |

风险与对策：

- **模型不守纪律** → 插件预算闸/归属是硬回退（M0 已实现，不依赖模型自觉）。
- **轮询成本** → `window_status` 一次取全局；周期 30–60s 用后台 job 非阻塞等待。
- **升级上下文丢失** → `blocked/*.md` 是文件系统转交凭证，不依赖对话记忆。

### 15.7 M1 实现清单（后续阶段）

1. ✅ 并发模式 preset 落盘并**挂载校验通过**：
   - 用户根 `~/.dsh/.agent-presets/concurrent/`（`preset.yml` + `agent.cordis.yml`）；
   - `standingKeyFor('concurrent')` → `{"agentPreset":"concurrent"}`，全部行激活、无泄漏服务 （2025-08-18，动态探针 `preset_probe` 实测）；
   - 版本化示例入仓库：`packages/session/window-session/examples/concurrent-preset/`；
   - 前置接线：`@deepseek-ai/dsh-window-session` 已链接进 `apps/cli/node_modules/@deepseek-ai/` （行包解析锚点），包自身 node_modules 补齐 4 个运行时依赖链接（schemastery/dsh-tools/dsh-llm/dsh-agent）。
2. 真机集成：真实 host + 模型下跑通 建窗/续派/介入/升级/关窗 闭环（§12 M0-B 余项）；
3. 主 Agent 队列收敛冒烟：C=1+4 小批（N=5）自测两队列收敛。

---

## 16. B/C/D 后续开发记录（2025-08-18）

### 16.1 B — 真实边界集成测试 ✅（`3e63c2bef3`）

把集成测试从 mock `agents` 升级为**真实 AgentRegistry**（headless 测试模式）：

- 挂载真实 `SessionStore` + `AgentRegistry` + `AgentDefaultModelConfig` + sqlite session-query 引擎 + 脚本化 agent 工厂（真实 session + 真实 Inbox + `setup` 真实调用）； 仅 `llm`/`agentPresets` 保留 mock（模型路由与 roster 属另一边界）。
- 验证结果：`window_create` 发布真实 agent（`ctx.agents.get` 命中）、任务卡进入真实 session、`window_read` 折叠**真实 surface 事件**（user/assistant message 来自真实 engine）、send/close 走真实 get/dispose、`agentPreset` 写入真实 session header。
- 关键签名核对（源码实读，非猜测）：真实 `AgentRegistry.create`（`AgentHandle{agent, dispose}`、`setup` 时序、meta 展平到 header）与 `SessionQueryService.readSurface` （`{session, capturedThroughSeq, events}`）均与插件结构调用完全吻合。

### 16.2 C — 队列收敛冒烟 ✅（`3e63c2bef3`）

8 任务 × 5 槽位预算的批次生命周期：填满→收割（close）→再派发。断言每步 `active ≤ 5`、峰值恰好触达预算、8 个窗口全部 dispose、最终 `status.active = 0` （槽位回收 + 预算闸在真实建窗路径上的回归）。

### 16.3 D1 — live lastActivity（session/event 订阅）✅（`26bb692300`）

- 插件订阅 post-commit `session/event` feed（全局监听、fiber 所有），对已跟踪窗口的 子会话事件 `touchActivity` —— 子 Agent 自主进展即刷新活动时间，供调度主 Agent 假死判定（§14.6），无需任何 orchestrator 工具调用。
- 语义修正：`window_status` 改为纯观察（不再 bump lastActivity）；活动来源 = `window_read`/`window_send`/session/event；`window_status` 输出 `lastActivity`。
- 测试：真实边界下，子会话自主追加 surface 事件后 `lastActivity` 推进。

### 16.4 D2 — Client 监控面板：**范围外（架构结论，留 M2）**

侦察结论：Web 端 client 插件图（`ClientModuleRegistry` / `window.__DSH_BOOT__`） 只枚举**宿主 loader 条目**（profile bundles）且要求包声明 `dsh.client`；**preset 行 的 client 半区不会进入浏览器 boot 图**。因此「窗口监控面板」若挂在并发 preset 上 无法加载；正确归宿是宿主平面行（M2，需 Typert RPC + host 组合行），本阶段不实现， 避免为不可加载功能引入 Typert 代码生成与 client bundle。

---

## 附录：与 v0.2 的差异小结

| 项 | v0.2 | 本草案 v0.2（S0 后） |
|---|---|---|
| 实现平面 | client-plugin 复用 RPC | **Host 半区组合 Services 为主**，Client 仅可选面板 |
| 实现形态 | 未定 | **真实 Host 包** `@deepseek-ai/dsh-window-session`，进仓库、可测试复用 |
| 建窗等价性 | 与 GUI 同 RPC | 与 GUI 同内部入口（`agents.create` + `installModelSelection` + preset mount） |
| 监控 | 主 Agent 轮询 progress.md | `readSurface` 拉取 + 事件订阅 + 心跳三层，均可选 |
| 归属/安全 | 未细化 | owner 校验、预算闸（registry）、JSON 边界 |
| 模型/effort | 提及可指定 | sp1 已定：`installModelSelection` 会话级注入，不走 RPC、不写全局默认 |
| 生命周期 | 未定 | sp4 已定：`ownerCtx = registry 根`，插件停更不销毁窗口 |
| 插件职责 | 不明确 | 明确「原语层 vs 业务层」边界，插件不实现队列/升级 |
