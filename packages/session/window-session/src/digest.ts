/**
 * Fold the ordered model surface (surface events) into compact text suitable
 * for a model-readable digest.
 */

import type { ContentBlock, MessageSource, UserMessage, AssistantMessage, ToolResultMessage } from '@deepseek-ai/dsh-llm'

/** The three ordered-surface event types; only these carry model-facing content. */
export interface SurfaceEventLike {
  type: 'user/message' | 'assistant/message' | 'tool/result'
  data: unknown
}

/** Per-event text cap (avoids one giant block dominating the digest). */
const USER_TEXT_CAP = 300
const ASSISTANT_TEXT_CAP = 300
const TOOL_TEXT_CAP = 200

/** Concatenate text blocks up to maxChars, slicing the final block to fit. */
function collectText(content: readonly ContentBlock[], maxChars: number): string {
  let out = ''
  for (const block of content) {
    if (out.length >= maxChars) break
    if (block.type === 'text') {
      const remaining = maxChars - out.length
      out += block.text.length > remaining ? block.text.slice(0, remaining) : block.text
    }
  }
  return out
}

/** Build a short prefix for a user-message source. */
function sourceLabel(source: MessageSource | undefined): string {
  if (source === undefined || source.kind === 'user') return ''
  if (source.kind === 'plugin') return `[${source.plugin}]`
  return '[model]'
}

export function foldSurfaceEvents(events: ReadonlyArray<SurfaceEventLike>, maxChars = 4000): string {
  const lines: string[] = []

  for (const evt of events) {
    if (evt.type === 'user/message') {
      const msg = evt.data as UserMessage
      const text = collectText(msg.content, USER_TEXT_CAP)
      if (text !== '') {
        const label = sourceLabel(msg.source)
        lines.push(label === '' ? text : `${label}: ${text}`)
      }
    } else if (evt.type === 'assistant/message') {
      const data = evt.data as { turn: number; step: number; message: AssistantMessage; usage?: Record<string, unknown> }
      const text = collectText(data.message.content, ASSISTANT_TEXT_CAP)
      if (text !== '') {
        const tokens = data.usage
          ? ` (${Object.entries(data.usage).map(([k, v]) => `${k}:${v}`).join(', ')})`
          : ''
        lines.push(`[${data.turn}:${data.step}] ${text}${tokens}`)
      }
    } else if (evt.type === 'tool/result') {
      const data = evt.data as {
        turn: number
        step: number
        message: ToolResultMessage
        error?: { name: string; code: string }
      }
      const text = collectText(data.message.content, TOOL_TEXT_CAP)
      if (text !== '') {
        const errTag = data.error ? ` ⚠${data.error.code}` : ''
        lines.push(`[${data.turn}:${data.step}] tool-result${errTag}: ${text}`)
      }
    }
  }

  const joined = lines.join('\n')
  if (joined === '') return '[no surface events]'
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined
}
