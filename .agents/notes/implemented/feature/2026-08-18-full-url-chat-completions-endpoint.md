# Agent Note: Full-URL OpenAI Chat Completions endpoints

Status: implemented

English | [中文](2026-08-18-full-url-chat-completions-endpoint.zh.md)

## Problem

Some gateways issue an opaque URL that is already the complete POST endpoint and forward that request to an upstream OpenAI Chat Completions endpoint. The existing `openai-completions` protocol treats the configured `baseURL` as a prefix, so the OpenAI SDK appends `/chat/completions`; a gateway URL such as `https://gateway.example/proxy/e/route` is therefore contacted as `https://gateway.example/proxy/e/route/chat/completions`, which changes the opaque route and can make the upstream reject it as an invalid URL.

## Decision

`llm-pi-ai` offers `openai-completions-full-url` beside `openai-completions`. Both use pi-ai's Chat Completions request conversion, streaming parser, tool-call handling, replay state, and reasoning compatibility switches. The regular protocol keeps prefix semantics; the full-URL protocol sends the configured `baseURL` as the exact HTTP request URL.

The full-URL adapter delegates to pi-ai instead of copying its protocol implementation. It adds an empty URL fragment marker to the request-local model descriptor before pi-ai constructs the OpenAI client. The SDK appends `/chat/completions` after that marker, placing the suffix in the fragment; Fetch never transmits fragments, so the server receives the configured path and query unchanged. The durable model descriptor and replay protocol id remain `openai-completions-full-url`.

Provider resolution requires the full-URL protocol to carry an explicit `baseURL` and rejects a configured fragment because fragments are not HTTP request data. Model discovery returns `DISCOVERY_UNSUPPORTED` for this protocol: a complete POST endpoint does not define a model-list endpoint from which `/models` can be derived, so its catalog is entered explicitly.

## Verification

The adapter integration test sends a streaming Chat Completions request through a local server whose endpoint includes an opaque path and query, then asserts that the server receives that exact path and query with no `/chat/completions` suffix. Provider tests cover both pi-ai stream entry points and the configuration refusals for a missing endpoint or a fragment-bearing endpoint. The Models settings snapshot includes the new schema-derived protocol option.

## Alternatives considered

**Copy pi-ai's Chat Completions implementation and replace only its HTTP call.** This would duplicate request conversion, provider compatibility, SSE parsing, tool calls, usage accounting, and error handling. Delegation keeps those behaviors on the installed pi-ai implementation.

**Change `openai-completions` to detect complete endpoints.** A URL cannot reliably reveal whether its final segments are a base path or an opaque route, and changing the existing protocol would break configurations that depend on suffix appending. A separate explicit protocol keeps both meanings stable.

**Add the SDK suffix as an ignored query parameter.** Gateways may sign or strictly compare query strings. A fragment is defined as client-side URL data and is never part of the HTTP target, so it preserves both path and query.

## Consequences

Opaque competition and enterprise gateway URLs can use the existing Chat Completions behavior without a sidecar proxy or a gateway-specific adapter. The protocol list gains one explicit variant, full-URL routes must enter models by hand, and the fragment-based delegation relies on the OpenAI SDK continuing to append its resource path after `baseURL`; the exact-request integration test detects a change in that behavior.
