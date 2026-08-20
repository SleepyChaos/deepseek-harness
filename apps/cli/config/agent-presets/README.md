# Shipped agent presets

[中文](README.zh.md)

This directory is the built-in preset roster for the CLI and Web profiles. Each
subdirectory with an `agent.cordis.yml` is discovered as one selectable preset;
`preset.yml` carries its display name, description, and optional order.

The `concurrent` preset is intentionally shipped here so a fresh clone exposes
the previously implemented window-session orchestration without requiring a
machine-local copy under `${DSH_HOME:-$HOME/.dsh}/.agent-presets/`.

The deployment default remains controlled by the `agent-presets.default`
setting. Adding a preset to this directory makes it available; it does not
silently change existing users' default or retrofit running sessions. Select
`concurrent` when starting a new session to expose `window_create`,
`window_read`, `window_send`, `window_status`, and `window_close`.

Do not generate a user preset during `git clone` or `postinstall`: user presets
are machine-local compositions and the roster already appends the user root.
Shipping the selectable composition in this directory keeps fresh installs
deterministic and avoids overwriting a user's settings.
