/**
 * LLM Router — Manages Anthropic SDK with prompt caching.
 *
 * Two-tier caching strategy:
 *   - Tier 1 (staticBlock): Agent identity, health framework, playbooks → CACHED
 *   - Tier 2 (semiStaticBlock): User profile, goals, facts → CACHED
 *   - Dynamic tail: Date, summaries, recent messages → NOT cached
 *
 * Model routing:
 *   - Haiku: Routine greetings, fact extraction, scheduled check-ins
 *   - Sonnet: Health conversations, anything with medical context
 *   - Opus: Reserved for future use (CEO-level reasoning)
 */

import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import type { BrainOutput, ChatMessage, ModelChoice } from '../../types/index.js'

const MODEL_MAP: Record<ModelChoice, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
}

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

/**
 * Stream a chat response with two-tier prompt caching.
 */
export async function* streamChat(
  brain: BrainOutput,
  messages: ChatMessage[],
  userMessage: string,
  model: ModelChoice = 'sonnet',
): AsyncGenerator<string> {
  const systemBlocks: Anthropic.TextBlockParam[] = [
    // Tier 1: Static — cached across ALL users (agent identity never changes)
    {
      type: 'text',
      text: brain.staticBlock,
      cache_control: { type: 'ephemeral' },
    },
    // Tier 2: Semi-static — cached per user (profile, goals, facts change weekly)
    {
      type: 'text',
      text: brain.semiStaticBlock,
      cache_control: { type: 'ephemeral' },
    },
    // Dynamic tail — never cached (date, summaries, medical context)
    {
      type: 'text',
      text: brain.dynamicBlock,
    },
  ]

  const apiMessages = [
    ...messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user' as const, content: userMessage },
  ]

  logger.info({
    model: MODEL_MAP[model],
    staticLen: brain.staticBlock.length,
    semiStaticLen: brain.semiStaticBlock.length,
    dynamicLen: brain.dynamicBlock.length,
    historyTurns: messages.length,
  }, 'Calling Claude API with prompt caching')

  const stream = client.messages.stream({
    model: MODEL_MAP[model],
    max_tokens: 4096,
    system: systemBlocks,
    messages: apiMessages,
  })

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text
    }
  }

  // Log cache performance
  const finalMessage = await stream.finalMessage()
  const usage = finalMessage.usage as unknown as Record<string, number>
  logger.info({
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreation: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  }, 'Claude API response — cache stats')
}

/**
 * Non-streaming call for background tasks (extraction, summaries).
 */
export async function callOnce(
  systemPrompt: string,
  userMessage: string,
  model: ModelChoice = 'haiku',
): Promise<string> {
  const response = await client.messages.create({
    model: MODEL_MAP[model],
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  })
  return response.content[0].type === 'text' ? response.content[0].text : ''
}
