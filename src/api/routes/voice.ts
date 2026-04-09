/**
 * Voice Call API — creates ephemeral tokens for WebRTC voice sessions
 * and assembles a condensed agent brain for the system prompt.
 *
 * POST /api/voice/session
 *   Body: { agentName: string, userId: string }
 *   Returns: { token: string, instructions: string, voice: string }
 */

import { Router } from 'express'
import { env } from '../../config/env.js'
import { loadAgentBrain } from '../../modules/brain/loader.js'
import { logger } from '../../lib/logger.js'

export const voiceRouter = Router()

voiceRouter.post('/session', async (req, res) => {
  const { agentName, userId } = req.body

  if (!agentName || !userId) {
    res.status(400).json({ error: 'agentName and userId required' })
    return
  }

  if (!env.OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY not configured' })
    return
  }

  try {
    // Load the agent's full brain
    const brain = await loadAgentBrain(agentName, userId, '[voice call session]')

    // Condense for voice — keep it under 2000 chars to control cost
    // System prompt is re-sent every turn as text tokens
    const instructions = condenseForVoice(brain.staticBlock, brain.semiStaticBlock, brain.dynamicBlock)

    // Get ephemeral token from OpenAI
    const tokenResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview',
        voice: 'echo',
        instructions,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 600,
        },
      }),
    })

    if (!tokenResponse.ok) {
      const errBody = await tokenResponse.text()
      logger.error({ status: tokenResponse.status, body: errBody }, 'OpenAI ephemeral token request failed')
      res.status(502).json({ error: 'Failed to create voice session' })
      return
    }

    const tokenData = await tokenResponse.json() as { client_secret?: { value: string }; id?: string }

    logger.info({ agentName, userId, instructionLen: instructions.length }, 'Voice session created')

    res.json({
      token: tokenData.client_secret?.value,
      instructions,
      voice: 'echo',
      sessionId: tokenData.id,
    })
  } catch (err) {
    logger.error({ err, agentName, userId }, 'Voice session creation failed')
    res.status(500).json({ error: 'Internal server error' })
  }
})

/**
 * Save transcript after a voice call ends.
 * POST /api/voice/transcript
 */
voiceRouter.post('/transcript', async (req, res) => {
  const { agentName, userId, chatId, transcript } = req.body

  if (!agentName || !userId || !transcript) {
    res.status(400).json({ error: 'agentName, userId, and transcript required' })
    return
  }

  try {
    const { saveMessage } = await import('../../modules/memory/sqlite.js')
    const { extractAndStoreFacts } = await import('../../workers/extract-facts.js')

    // Save the full transcript as a conversation
    for (const turn of transcript) {
      saveMessage(userId, agentName, chatId || 'voice-call', turn.role, turn.content)
    }

    // Extract facts from the conversation
    if (chatId) {
      const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1)
      await extractAndStoreFacts(userId, agentName, chatId, displayName)
    }

    logger.info({ agentName, userId, turns: transcript.length }, 'Voice transcript saved')
    res.json({ saved: true, turns: transcript.length })
  } catch (err) {
    logger.error({ err }, 'Voice transcript save failed')
    res.status(500).json({ error: 'Failed to save transcript' })
  }
})

/**
 * Condense the agent brain into a voice-friendly system prompt.
 * Must be concise — every token is re-sent on each turn, directly impacting cost.
 */
function condenseForVoice(staticBlock: string, semiStaticBlock: string, dynamicBlock: string): string {
  // Extract the most important parts:
  // - Agent identity (first ~500 chars of static)
  // - Current health plan (from semi-static)
  // - Today's context (from dynamic)

  const identity = staticBlock.slice(0, 800)
  const plan = extractSection(semiStaticBlock, 'CURRENT_PLAN', 600)
  const memory = extractSection(semiStaticBlock, 'WHAT YOU KNOW', 400)
  const today = dynamicBlock.slice(0, 300)

  return `You are a health companion in a VOICE CONVERSATION. Speak naturally and conversationally — short sentences, warm tone, like talking to a friend. Never use markdown, bullet points, or formatted text. Keep responses under 3 sentences unless asked for detail.

${identity}

${plan ? `\nCurrent plan:\n${plan}` : ''}
${memory ? `\nWhat you know about this person:\n${memory}` : ''}
${today ? `\nToday:\n${today}` : ''}

Remember: this is a spoken conversation. Be warm, direct, and human. Ask follow-up questions. Listen more than you talk.`
}

function extractSection(text: string, sectionName: string, maxLen: number): string {
  const idx = text.indexOf(sectionName)
  if (idx === -1) return ''
  const section = text.slice(idx, idx + maxLen)
  const lastNewline = section.lastIndexOf('\n\n')
  return lastNewline > maxLen * 0.3 ? section.slice(0, lastNewline) : section
}
