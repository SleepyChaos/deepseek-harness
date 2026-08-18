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

/** Extract plain text blocks from a content array, capped. */
function collectText(content: readonly ContentBlock[], maxChars: number): string {
  let out = ''
  for (const block of content) {
    if (out.length >= maxChars) break
    if (block.type === 'text') out += block.text
  }
  return out || '(empty)'
}

/** Build a short prefix for a user-message source. */
function sourceLabel(source: MessageSource | undefined): string {
  if (source === undefined || source.kind === 'user') return ''
  if (source.kind === 'plugin') return `[${source.plugin}]`
  return '[model]'
}

export function foldSurfaceEvents(events: ReadonlyArray<SurfaceEventLike>, maxChars = 4000): string {
  const lines: string[] = []
  let budget = maxChars

  for (const evt of events) {
    const used = lines.join('\n').length

    if (evt.type === 'user/message') {
      const msg = evt.data as UserMessage
      const label = sourceLabel(msg.source)
      if (label !== '') lines.push(`${label}:`)
      const text = collectText(msg.content, Math.max(0, Math.min(budget - used - 8, 2000)))
      if (budget > 0 && text !== '(empty)') {
        lines.push(text.length > 300 ? `${text.slice(0, 300)}…` : text)
      }
    } else if (evt.type === 'assistant/message') {
      const data = evt.data as { turn: number; step: number; message: AssistantMessage; usage?: Record<string, unknown> }
      const text = collectText(data.message.content, Math.max(0, Math.min(budget - used - 12, 1500)))
      const tokens = data.usage
        ? ` (${Object.entries(data.usage).map(([k, v]) => `${k}:${v}`).join(', ')})`
        : ''
      if (budget > 0 && text !== '(empty)') {
        lines.push(`[${data.turn}:${data.step}] ${text.length > 300 ? `${text.slice(0, 300)}…` : text}${tokens}`)
      }
    } else if (evt.type === 'tool/result') {
      const data = evt.data as {
        turn: number
        step: number
        message: ToolResultMessage
        error?: { name: string; code: string }
      }
      const text = collectText(data.message.content, Math.max(0, Math.min(budget - used - 12, 800)))
      const errTag = data.error ? ` ⚠${data.error.code}` : ''
      if (budget > 0 && text !== '(empty)') {
        lines.push(`[${data.turn}:${data.step}] tool-result${errTag}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`)
      }
    }

    budget -= lines.join('\n').length - used
    if (budget <= 0) {
      lines.push('…(truncated)')
      break
    }
  }

  return lines.join('\n') || '[no surface events]'
}
