/**
 * Chat Route — SSE streaming endpoint (Web API)
 *
 * Requires Supabase to be configured. Returns 503 if not available.
 * The primary chat interface is Telegram (src/transport/telegram.ts).
 */

import { Router } from 'express'
import { authMiddleware, type AuthRequest } from '../middleware/auth.js'
import { checkEscalation } from '../../modules/escalation/index.js'
import { buildBrain } from '../../modules/brain/index.js'
import { streamChat } from '../../modules/llm/index.js'
import { resolveMedicalContext } from '../../modules/medical/index.js'
import { retrieveUserFacts } from '../../modules/memory/retrieve.js'
import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import type { ChatMessage, HealthProfile, HealthGoal } from '../../types/index.js'

export const chatRouter = Router()

chatRouter.post('/', authMiddleware, async (req: AuthRequest, res) => {
  if (!supabase) {
    res.status(503).json({ error: 'Web API requires Supabase configuration' })
    return
  }

  const userId = req.userId!
  const { message } = req.body as { message: string }

  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' })
    return
  }

  const escalation = checkEscalation(message)
  if (escalation.tier === 1) {
    logger.warn({ userId, pattern: escalation.triggerPattern }, 'ESCALATION TIER 1')
    res.json({ tier: 1, content: escalation.messageOverride })
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    const [profileResult, goalsResult, historyResult, userFacts, medicalContext] = await Promise.all([
      supabase.from('health_profiles').select('*').eq('user_id', userId).single(),
      supabase.from('health_goals').select('*').eq('user_id', userId).eq('status', 'active'),
      supabase.from('chat_messages').select('role, content').eq('user_id', userId).order('created_at', { ascending: false }).limit(20),
      retrieveUserFacts(message, userId),
      resolveMedicalContext(message, userId),
    ])

    const profile = profileResult.data as HealthProfile | null
    const goals = (goalsResult.data || []) as HealthGoal[]
    const recentMessages = ((historyResult.data || []) as ChatMessage[]).reverse()

    const now = new Date().toLocaleString('en-NZ', { timeZone: env.TIMEZONE })
    const brain = buildBrain({
      profile,
      goals,
      recentMessages,
      sessionSummaries: [],
      userFacts,
      medicalContext,
      currentDate: now,
    })

    let fullResponse = ''
    for await (const chunk of streamChat(brain, recentMessages, message)) {
      fullResponse += chunk
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`)
    }

    if (escalation.mandatorySuffix) {
      fullResponse += escalation.mandatorySuffix
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: escalation.mandatorySuffix })}\n\n`)
    }

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    res.end()

    await supabase.from('chat_messages').insert([
      { user_id: userId, role: 'user', content: message },
      { user_id: userId, role: 'assistant', content: fullResponse, escalation_tier: escalation.tier },
    ])
  } catch (err) {
    logger.error({ err, userId }, 'Chat stream failed')
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Something went wrong. Try again.' })}\n\n`)
    res.end()
  }
})
