/**
 * Protocol identifiers shared by provider construction and catalog validation.
 *
 * @module dsh-llm-pi-ai/protocol
 */

/** OpenAI Chat Completions with a base URL that receives `/chat/completions`. */
export const OPENAI_COMPLETIONS_PROTOCOL = 'openai-completions'

/** OpenAI Chat Completions sent to the configured URL without a path suffix. */
export const OPENAI_COMPLETIONS_FULL_URL_PROTOCOL = 'openai-completions-full-url'

/**
 * Whether a protocol uses the OpenAI Chat Completions request and response format.
 * @param api - resolved protocol identifier.
 * @returns whether Chat Completions compatibility settings apply.
 */
export function isOpenAICompletionsProtocol(api: string): boolean {
  return api === OPENAI_COMPLETIONS_PROTOCOL || api === OPENAI_COMPLETIONS_FULL_URL_PROTOCOL
}
