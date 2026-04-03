/**
 * Chat Route — SSE streaming endpoint
 *
 * Flow:
 * 1. Auth → get user_id
 * 2. Escalation check (sync, $0)
 * 3. Fetch user state (profile, goals, facts, summaries)
 * 4. Build brain (pure function)
 * 5. Stream response via SSE
 * 6. Append escalation suffix if Tier 2-4
 * 7. Queue background extraction job
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
import type { ChatMessage, HealthProfile, HealthGoal } from '../../types/index.js'

export const chatRouter = Router()

chatRouter.post('/', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.userId!
  const { message } = req.body as { message: string }

  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' })
    return
  }

  // 1. Escalation check (sync, before anything else)
  const escalation = checkEscalation(message)
  if (escalation.tier === 1) {
    logger.warn({ userId, pattern: escalation.triggerPattern }, 'ESCALATION TIER 1')
    res.json({ tier: 1, content: escalation.messageOverride })
    return
  }

  // 2. Set up SSE
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  try {
    // 3. Fetch user state in parallel
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

    // 4. Build brain (pure function)
    const now = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland' })
    const brain = buildBrain({
      profile,
      goals,
      recentMessages,
      sessionSummaries: [], // TODO: fetch from Redis
      userFacts,
      medicalContext,
      currentDate: now,
    })

    // 5. Stream response
    let fullResponse = ''
    for await (const chunk of streamChat(brain, recentMessages, message)) {
      fullResponse += chunk
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`)
    }

    // 6. Append escalation suffix
    if (escalation.mandatorySuffix) {
      fullResponse += escalation.mandatorySuffix
      res.write(`data: ${JSON.stringify({ type: 'chunk', content: escalation.mandatorySuffix })}\n\n`)
    }

    // 7. Signal done
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`)
    res.end()

    // 8. Save messages to Supabase (fire-and-forget)
    await supabase.from('chat_messages').insert([
      { user_id: userId, role: 'user', content: message },
      { user_id: userId, role: 'assistant', content: fullResponse, escalation_tier: escalation.tier },
    ])

    // TODO Phase 2: Queue background extraction job via BullMQ

  } catch (err) {
    logger.error({ err, userId }, 'Chat stream failed')
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Something went wrong. Try again.' })}\n\n`)
    res.end()
  }
})
