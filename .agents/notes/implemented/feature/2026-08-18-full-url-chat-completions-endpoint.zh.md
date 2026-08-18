# Agent Note: 完整 URL 的 OpenAI Chat Completions 端点

Status: implemented

[English](2026-08-18-full-url-chat-completions-endpoint.md) | 中文

## 问题

有些网关会提供一个不透明 URL；它已经是完整 POST 端点，并把该请求转发到上游 OpenAI Chat Completions 端点。现有 `openai-completions` 协议把配置的 `baseURL` 当作前缀，因此 OpenAI SDK 会追加 `/chat/completions`；系统实际访问 `https://gateway.example/proxy/e/route/chat/completions`，而不是 `https://gateway.example/proxy/e/route`，这会改变不透明路由，并可能让上游将其作为无效 URL 拒绝。

## 决策

`llm-pi-ai` 在 `openai-completions` 之外提供 `openai-completions-full-url`。两者都使用 pi-ai 的 Chat Completions 请求转换、流解析器、工具调用处理、回放状态和推理兼容开关。普通协议保留前缀语义；完整 URL 协议会把配置的 `baseURL` 作为确切 HTTP 请求 URL 发送。

完整 URL 适配器委托给 pi-ai，而不复制其协议实现。在 pi-ai 构造 OpenAI 客户端之前，适配器会给请求本地的模型描述符加一个空 URL 片段标记。SDK 在该标记后追加 `/chat/completions`，于是后缀落入片段中；Fetch 绝不会传输片段，因此服务器收到的配置路径和查询参数保持不变。持久化模型描述符与回放协议 id 仍为 `openai-completions-full-url`。

提供方解析要求完整 URL 协议携带显式 `baseURL`，并拒绝配置了片段的地址，因为片段并不是 HTTP 请求数据。该协议的模型发现会返回 `DISCOVERY_UNSUPPORTED`：完整 POST 端点并没有定义一个可推导出 `/models` 的模型列表端点，因此必须显式填写其 catalog。

## 验证

适配器集成测试通过一个端点包含不透明路径和查询参数的本地服务器发送流式 Chat Completions 请求，然后断言服务器收到的路径和查询参数完全一致，且没有 `/chat/completions` 后缀。提供方测试覆盖两个 pi-ai 流入口，以及缺少端点和端点包含片段时的配置拒绝。Models 设置快照包含由 schema 派生的新协议选项。

## 考虑过的替代方案

**复制 pi-ai 的 Chat Completions 实现，只替换其中的 HTTP 调用。** 这会重复请求转换、提供方兼容逻辑、SSE 解析、工具调用、用量统计与错误处理。通过委托，这些行为继续由已安装的 pi-ai 实现负责。

**让 `openai-completions` 自动判断完整端点。** URL 无法可靠表明最后几段属于基础路径还是不透明路由；改变现有协议还会破坏依赖追加后缀的配置。独立的显式协议可以稳定保留两种含义。

**把 SDK 后缀添加为可忽略的查询参数。** 网关可能会签名查询字符串，或严格比较它。片段按定义属于客户端 URL 数据，绝不会成为 HTTP 目标的一部分，因此可以同时保留路径与查询参数。

## 后果

比赛和企业环境中的不透明网关 URL 可以复用现有 Chat Completions 行为，无需 sidecar proxy 或网关专用适配器。协议列表增加一个显式变体；完整 URL 路由必须手工填写模型；委托机制依赖 OpenAI SDK 继续在 `baseURL` 后追加资源路径，确切请求集成测试会检测该行为发生变化。
