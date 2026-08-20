# 内置 Agent 预设

[English](README.md) | 中文

此目录是 CLI 和 Web profile 的内置预设清单。每个包含
`agent.cordis.yml` 的子目录都会被发现为一个可选择的预设；`preset.yml`
保存显示名称、描述和可选排序值。

`concurrent` 预设放在这里，是为了让全新 clone 的仓库无需再把并发窗口
组装复制到 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/`，就能发现之前实现的
窗口会话调度能力。

部署默认值仍由 `agent-presets.default` 设置控制。把预设加入此目录只会让它
可选，不会悄悄改变已有用户的默认值，也不会给正在运行的会话重新组装工具。
新建会话时选择 `concurrent`，即可获得 `window_create`、`window_read`、
`window_send`、`window_status` 和 `window_close`。

不要在 `git clone` 或 `postinstall` 时自动生成用户预设：用户预设属于本机，
而 roster 已经会追加用户根目录。把可选组装随应用发布，能保证全新安装可复现，
也不会覆盖用户自己的设置。
