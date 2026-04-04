/**
 * Fact Extraction Worker — Haiku-powered memory extraction
 *
 * After every conversation, extracts permanent facts about the user.
 * Decisions: Add / Update / Skip against existing facts.
 * Writes to SQLite user_facts table.
 *
 * Ported from tom-command-center/core/user_memory.py extract_and_store_memories()
 */

import Anthropic from '@anthropic-ai/sdk'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import {
  getUserFacts, addFact, updateFact, logExtraction,
  getRecentMessages, type StoredFact,
} from '../modules/memory/sqlite.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

const FACT_CATEGORIES = [
  'preference', 'biographical', 'goal', 'decision', 'constraint',
  'pattern', 'opinion', 'relationship', 'context', 'learning',
]

function buildExtractionPrompt(existingFacts: StoredFact[], conversationText: string): string {
  const factsFormatted = existingFacts.slice(0, 50)
    .map(f => `- [${f.category}] ${f.fact}`)
    .join('\n')

  return `You are a memory extraction system. Extract PERMANENT facts about the USER that will still be relevant in future conversations.

RULES:
- Only extract facts the user EXPLICITLY stated or clearly implied
- Never infer or assume anything not directly supported by the text
- If the user corrects something, extract the CORRECTED version
- Rate confidence: 1.0 = explicitly stated, 0.8 = strongly implied, 0.5 = loosely implied
- Compare against existing facts. For each new fact, decide: ADD (new info), UPDATE (modifies existing), SKIP (already known)

CATEGORIES (use exactly one):
- biographical: permanent facts about who they are (name, age, location, medical history, diagnoses)
- goal: enduring goals and aspirations (not what they asked about in this message)
- constraint: hard limits (medical restrictions, intolerances, can't-do-list)
- pattern: recurring behaviours, triggers, responses observed across multiple instances
- preference: stable likes/dislikes/ways of working
- decision: significant choices they've made (stopped a medication, started a protocol)
- relationship: people in their life and dynamics
- opinion: their views and beliefs
- learning: insights they've had or things they've understood
- context: current life situation (job, living situation, phase of recovery) — only if durable, not momentary

DO NOT EXTRACT:
- What the user asked about in this specific conversation ("User asked about X")
- What the agent said or recommended
- Timestamps, dates, or time references
- Scheduled tasks or check-in prompts
- Transient states that won't matter next week
- Anything that is already captured in the existing facts

EXISTING FACTS ABOUT THIS USER:
${factsFormatted || '(none yet)'}

CONVERSATION:
${conversationText}

Return ONLY a JSON array. No explanation, no markdown, just the array:
[
  {"action": "ADD|UPDATE|SKIP", "fact": "...", "category": "...", "confidence": 0.0-1.0, "updates_fact_index": null}
]

If updating, set updates_fact_index to the 0-based index of the existing fact being updated.
If no new facts to extract, return: []`
}

/**
 * Extract facts from recent conversation and store in SQLite.
 * Called as fire-and-forget after each conversation.
 */
export async function extractAndStoreFacts(
  userId: string,
  agentId: string,
  chatId: string,
  agentDisplayName: string,
): Promise<void> {
  try {
    // Get recent messages for this conversation
    const messages = getRecentMessages(userId, agentId, chatId, 10, 2)
    if (messages.length < 2) return // Need at least 1 exchange

    // Format conversation
    const conversationText = messages
      .map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content.slice(0, 500)}`)
      .join('\n\n')

    // Get existing facts (agent-specific, not global)
    const existingFacts = getUserFacts(userId, agentId, undefined, false)

    // Call Haiku for extraction
    const prompt = buildExtractionPrompt(existingFacts, conversationText)
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })

    const responseText = response.content[0].type === 'text' ? response.content[0].text : ''

    // Parse JSON (handle markdown wrapping)
    let jsonStr = responseText.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    let factsToProcess: Array<{
      action: string
      fact: string
      category: string
      confidence: number
      updates_fact_index: number | null
    }>

    try {
      factsToProcess = JSON.parse(jsonStr)
    } catch {
      logger.warn({ responseText: responseText.slice(0, 200) }, 'Failed to parse Haiku extraction response')
      return
    }

    if (!Array.isArray(factsToProcess)) return

    let added = 0
    let updated = 0
    let skipped = 0

    for (const item of factsToProcess) {
      const action = (item.action || '').toUpperCase()
      const factText = (item.fact || '').trim()
      let category = (item.category || 'general').toLowerCase()
      const confidence = typeof item.confidence === 'number' ? item.confidence : 1.0

      if (!FACT_CATEGORIES.includes(category)) category = 'general'
      if (!factText) continue

      if (action === 'ADD') {
        addFact(userId, agentId, factText, category, confidence,
          `Extracted from ${agentDisplayName} conversation`)
        added++
      } else if (action === 'UPDATE') {
        const idx = item.updates_fact_index
        if (idx !== null && idx !== undefined && idx >= 0 && idx < existingFacts.length) {
          const oldFact = existingFacts[idx]
          updateFact(oldFact.id, factText, confidence)
          updated++
        } else {
          // Can't find old fact — add as new
          addFact(userId, agentId, factText, category, confidence,
            `Updated from ${agentDisplayName} conversation`)
          added++
        }
      } else {
        skipped++
      }
    }

    logExtraction(userId, agentId, added, updated, skipped)

    if (added > 0 || updated > 0) {
      logger.info({
        userId, agentId, added, updated, skipped,
      }, 'Memory extraction complete')
    }
  } catch (err) {
    logger.error({ err, userId, agentId }, 'Memory extraction failed (non-fatal)')
  }
}
