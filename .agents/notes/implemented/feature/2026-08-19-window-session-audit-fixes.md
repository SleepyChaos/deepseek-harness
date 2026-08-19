# Agent Note: Window-session audit fixes

Status: implemented

English | [中文](2026-08-19-window-session-audit-fixes.zh.md)

## Problem

The concurrent window-session branch had four correctness gaps at its tool boundary: preset resolution or mounting could be bypassed, an anonymous caller could become a shared `unknown` owner, idle windows returned status without their final surface, and `window_close({ archive: true })` reported an archive without changing the durable workspace archive set. Missing live agents could also occupy budget slots indefinitely after an external disposal.

## Decision

Require the agent-presets service and resolve/mount the requested preset before publishing a child. Require a live caller session for creation and ownership checks, preserve the caller workspace as the child default, and use a UUID-based window identity. Read the session surface for both running and idle children, validate the tail count, and prune externally disposed entries during status refresh. Archive through the optional workspace registry before closing; archive or disposal errors are returned and leave the tracked window available for retry.

## Verification

Focused window-session and full-URL tests pass, including 117 tests across six files. The real AgentRegistry test now verifies that an idle child still exposes its final surface, and the tool boundary test verifies durable archive invocation before disposal.

## Consequences

The concurrent preset must run in a host that mounts `agentPresets`; this is now an explicit load-time requirement rather than a silent no-op. Archiving requires `workspaceRegistry`; requesting it without that service fails without closing the child.

## Alternatives considered

- **Leave archive as a response-only flag.** Rejected because it would contradict the documented archive semantics and durable workspace registry.
- **Read only running windows.** Rejected because completed output is needed for scheduling settlement.
- **Keep preset mounting best-effort.** Rejected because it could publish a child with a mismatched or missing preset composition.
