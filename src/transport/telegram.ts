/**
 * Telegram Transport — Polling loop + message dispatch
 *
 * Ported from orchestrator.py start_polling() + handle_incoming_message()
 *
 * Flow:
 *   Telegram message → identify agent/user → escalation check
 *   → load brain → call Claude → learning loop → format → send
 */

import type TelegramBot from 'node-telegram-bot-api'
import { startPollingBot, sendMessage, sendTyping, downloadFileAsBase64, downloadFileAsBuffer, sendVoiceMessage } from '../lib/telegram.js'
import OpenAI from 'openai'
import { AGENTS, CHAT_TO_AGENT, AUTHORIZED_USERS } from '../config/telegram.js'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { checkEscalation } from '../modules/escalation/index.js'
import { loadAgentBrain, loadTaskPrompt } from '../modules/brain/loader.js'
import { streamChat, callOnce } from '../modules/llm/index.js'
import { processResponseLearning } from '../modules/learning/index.js'
import { formatForTelegram } from './telegram-formatter.js'
import { saveMessage, getRecentMessages } from '../modules/memory/sqlite.js'
import { extractAndStoreFacts } from '../workers/extract-facts.js'
import { hasOnboardingSession, startOnboarding, processOnboardingMessage } from '../modules/onboarding/index.js'
import { extractFromImage, interpretResults, formatResultsSummary } from '../modules/biomarkers/index.js'
import { saveBiomarkerResult } from '../modules/metrics/index.js'
import { isValidMetric, logMetric, getRecentMetrics, getMetricNames } from '../modules/metrics/index.js'
import type { ChatMessage } from '../types/index.js'

/**
 * Start the Telegram polling loop.
 * Registers message handlers and begins listening.
 */
export function startTelegramTransport() {
  const bot = startPollingBot()

  bot.on('message', (msg) => {
    // Fire-and-forget — don't block polling loop
    handleMessage(msg).catch(err => {
      logger.error({ err, chatId: msg.chat.id }, 'Telegram message handler crashed')
    })
  })

  logger.info('Telegram transport started — listening for messages')
}

async function handleMessage(msg: TelegramBot.Message) {
  const chatId = String(msg.chat.id)
  const senderId = String(msg.from?.id ?? '')
  const text = msg.text?.trim()

  if (!msg.text?.trim() && !msg.voice && !msg.photo && !msg.document) return

  // ─── Onboarding: unknown chats or in-progress onboarding ───
  if (hasOnboardingSession(chatId)) {
    if (msg.text?.trim()) {
      await processOnboardingMessage(chatId, msg.text.trim())
    }
    return
  }

  // Identify agent from chat ID
  const agentName = CHAT_TO_AGENT[chatId]
  if (!agentName) {
    // Unknown chat — start onboarding if sender is authorized
    logger.info({ chatId, senderId }, 'Message from unknown chat — attempting onboarding')
    await startOnboarding(chatId, senderId)
    return
  }

  const agentConfig = AGENTS[agentName]

  // Security: check sender is authorized or is in a companion group chat
  const isOwner = senderId === env.TELEGRAM_OWNER_ID
  const isAuthorized = AUTHORIZED_USERS.includes(senderId)
  if (!isOwner && !isAuthorized) {
    logger.info({ senderId, chatId, agent: agentName }, 'Message from non-owner user in group chat')
  }

  // Handle voice messages — transcribe via Whisper, respond via TTS
  if (msg.voice && !text) {
    if (!env.OPENAI_API_KEY) {
      await sendMessage(chatId, 'Voice messages require OpenAI API key for transcription. Please send text.')
      return
    }
    await handleVoiceMessage(chatId, agentName, agentConfig, msg)
    return
  }

  // Handle photo messages (blood test images)
  if (msg.photo && msg.photo.length > 0) {
    await handleBloodTestPhoto(chatId, agentConfig.userId, agentConfig.displayName, msg)
    return
  }

  // Handle document messages (blood test PDFs)
  if (msg.document) {
    const mime = msg.document.mime_type || ''
    if (mime.startsWith('image/')) {
      await handleBloodTestPhoto(chatId, agentConfig.userId, agentConfig.displayName, msg)
      return
    }
    // For now, only handle image documents — PDF support via Claude Vision later
    await sendMessage(chatId, 'I can read blood test images (photos). PDF support coming soon — for now, take a photo of your results.')
    return
  }

  if (!text) return

  // Handle commands
  if (text.startsWith('/')) {
    await handleCommand(chatId, agentName, agentConfig.userId, text)
    return
  }

  // ─── Main message flow ───

  // 1. Escalation check ($0, sync)
  const escalation = checkEscalation(text)
  if (escalation.tier === 1) {
    logger.warn({ userId: agentConfig.userId, agent: agentName, pattern: escalation.triggerPattern }, 'ESCALATION TIER 1')
    await sendMessage(chatId, escalation.messageOverride!)
    return
  }

  // 2. Typing indicator
  await sendTyping(chatId)

  // 3. Save user message
  saveMessage(agentConfig.userId, agentName, chatId, 'user', text)

  // 4. Load agent brain
  const brain = await loadAgentBrain(agentName, agentConfig.userId, text)

  // 5. Get conversation history
  const recentMessages = getRecentMessages(agentConfig.userId, agentName, chatId, 6, 48)
  const historyForLLM: ChatMessage[] = recentMessages.map(m => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  // 6. Call Claude (non-streaming for Telegram — we send full response)
  let fullResponse = ''
  try {
    for await (const chunk of streamChat(brain, historyForLLM, text, agentConfig.model)) {
      fullResponse += chunk
    }
  } catch (err) {
    logger.error({ err, agent: agentName }, 'Claude API call failed')
    await sendMessage(chatId, 'Sorry, I hit an error. Try again in a moment.')
    return
  }

  // 7. Learning loop (extract markers, append session log, update CONTEXT.md)
  const cleanedResponse = processResponseLearning(agentName, text, fullResponse)

  // 8. Append escalation suffix if needed
  let finalResponse = cleanedResponse
  if (escalation.mandatorySuffix) {
    finalResponse += '\n\n' + escalation.mandatorySuffix
  }

  // 9. Format for Telegram
  const formatted = formatForTelegram(finalResponse)

  // 10. Send to Telegram
  await sendMessage(chatId, formatted)

  // 11. Save assistant message
  saveMessage(agentConfig.userId, agentName, chatId, 'assistant', fullResponse)

  // 12. Queue background fact extraction (fire-and-forget)
  extractAndStoreFacts(agentConfig.userId, agentName, chatId, agentConfig.displayName)
    .catch(err => logger.error({ err }, 'Background fact extraction failed'))

  logger.info({
    agent: agentName,
    userId: agentConfig.userId,
    inputLen: text.length,
    outputLen: fullResponse.length,
  }, 'Message handled')
}

/** Handle slash commands */
async function handleCommand(chatId: string, agentName: string, userId: string, command: string) {
  const [cmd, ...args] = command.split(' ')

  switch (cmd) {
    case '/memory': {
      const { loadUserMemory } = await import('../modules/memory/sqlite.js')
      const memory = loadUserMemory(userId, agentName)
      await sendMessage(chatId, memory || 'No memories stored yet.')
      break
    }
    case '/forget': {
      const searchText = args.join(' ')
      if (!searchText) {
        await sendMessage(chatId, 'Usage: /forget <search text> or /forget all')
        return
      }
      const { deleteFactsByText, deleteAllFacts } = await import('../modules/memory/sqlite.js')
      if (searchText.toLowerCase() === 'all') {
        const count = deleteAllFacts(userId)
        await sendMessage(chatId, `Deleted ${count} memories.`)
      } else {
        const count = deleteFactsByText(userId, searchText)
        await sendMessage(chatId, `Deleted ${count} memories matching "${searchText}".`)
      }
      break
    }
    case '/log': {
      const metricName = args[0]?.toLowerCase()
      const value = parseFloat(args[1])
      if (!metricName || isNaN(value)) {
        await sendMessage(chatId, `Usage: /log <metric> <value>\n\nAvailable metrics: ${getMetricNames().join(', ')}`)
        return
      }
      if (!isValidMetric(metricName)) {
        await sendMessage(chatId, `Unknown metric: ${metricName}\n\nAvailable: ${getMetricNames().join(', ')}`)
        return
      }
      const result = logMetric(userId, metricName, value)
      await sendMessage(chatId, result)
      break
    }
    case '/data': {
      const metrics = getRecentMetrics(userId)
      await sendMessage(chatId, metrics)
      break
    }
    default:
      await sendMessage(chatId, `Unknown command: ${cmd}\n\nAvailable: /memory, /forget, /log, /data`)
  }
}

/**
 * Handle blood test photo/image — extract biomarkers, store, interpret.
 */
async function handleBloodTestPhoto(
  chatId: string, userId: string, displayName: string, msg: TelegramBot.Message,
) {
  await sendMessage(chatId, 'Reading your blood test results...')
  await sendTyping(chatId)

  try {
    // Get the largest photo (best quality)
    const fileId = msg.photo
      ? msg.photo[msg.photo.length - 1].file_id
      : msg.document?.file_id

    if (!fileId) {
      await sendMessage(chatId, "Couldn't read that file. Try sending a clearer photo of your blood test.")
      return
    }

    const file = await downloadFileAsBase64(fileId)
    if (!file || !file.mimeType.startsWith('image/')) {
      await sendMessage(chatId, "Couldn't download the image. Try again.")
      return
    }

    // Extract biomarkers via Claude Vision
    const results = await extractFromImage(file.base64, file.mimeType)
    if (results.length === 0) {
      await sendMessage(chatId, "I couldn't extract any blood test results from that image. Try sending a clearer photo, or paste your results as text.")
      return
    }

    // Store in SQLite
    for (const r of results) {
      saveBiomarkerResult(userId, r.test_name, r.value, r.unit, r.reference_low, r.reference_high, r.flag)
    }

    // Send extraction summary
    const summary = formatResultsSummary(results)
    await sendMessage(chatId, `Found ${results.length} markers.\n\n${summary}\n\nGenerating interpretation...`)
    await sendTyping(chatId)

    // Generate interpretation
    const interpretation = await interpretResults(displayName, results)
    const formatted = formatForTelegram(interpretation)
    await sendMessage(chatId, formatted)

    // Save as message for context
    const agentName = CHAT_TO_AGENT[chatId]
    if (agentName) {
      saveMessage(userId, agentName, chatId, 'user', `[Blood test photo — ${results.length} markers extracted]`)
      saveMessage(userId, agentName, chatId, 'assistant', interpretation)
    }

    logger.info({ userId, resultCount: results.length }, 'Blood test processed')
  } catch (err) {
    logger.error({ err, userId }, 'Blood test processing failed')
    await sendMessage(chatId, 'Error processing blood test. Try sending a clearer photo, or paste your results as text.')
  }
}

/**
 * Run a scheduled task for a companion agent.
 * Loads agent brain, reads task prompt, calls Claude, sends to Telegram.
 */
export async function runScheduledTask(agentName: string, taskName: string) {
  const agentConfig = AGENTS[agentName]
  if (!agentConfig) {
    logger.error({ agentName, taskName }, 'Unknown agent for scheduled task')
    return
  }

  logger.info({ agent: agentName, task: taskName }, 'Running scheduled task')

  try {
    // Load task prompt
    const taskPrompt = loadTaskPrompt(agentName, taskName)
    if (!taskPrompt) {
      logger.warn({ agentName, taskName }, 'No prompt file found for task')
      return
    }

    // Load agent brain
    const brain = await loadAgentBrain(agentName, agentConfig.userId, taskPrompt)

    // Call Claude (non-streaming, use callOnce for scheduled tasks)
    const systemPrompt = [brain.staticBlock, brain.semiStaticBlock, brain.dynamicBlock].join('\n\n')
    const response = await callOnce(systemPrompt, taskPrompt, agentConfig.model)

    // Learning loop
    const cleanedResponse = processResponseLearning(agentName, `[Scheduled: ${taskName}]`, response)

    // Format and send
    const formatted = formatForTelegram(cleanedResponse)
    await sendMessage(agentConfig.chatId, formatted)

    // Save messages
    saveMessage(agentConfig.userId, agentName, agentConfig.chatId, 'user', `[Scheduled: ${taskName}]`)
    saveMessage(agentConfig.userId, agentName, agentConfig.chatId, 'assistant', response)

    // Background fact extraction
    extractAndStoreFacts(agentConfig.userId, agentName, agentConfig.chatId, agentConfig.displayName)
      .catch(err => logger.error({ err }, 'Scheduled task fact extraction failed'))

    logger.info({ agent: agentName, task: taskName, responseLen: response.length }, 'Scheduled task complete')
  } catch (err) {
    logger.error({ err, agentName, taskName }, 'Scheduled task failed')
    // Notify Tom
    try {
      const tomChat = AGENTS.apex?.chatId
      if (tomChat) {
        await sendMessage(tomChat, `⚠️ Scheduled task failed: ${agentName}/${taskName}\n\nError: ${err instanceof Error ? err.message : String(err)}`)
      }
    } catch {
      // Can't even notify — just log
    }
  }
}

/**
 * Handle voice messages — transcribe with Whisper, process through agent brain,
 * respond with TTS voice note + text fallback.
 */
async function handleVoiceMessage(
  chatId: string, agentName: string, agentConfig: typeof AGENTS[string], msg: TelegramBot.Message,
) {
  const userId = agentConfig.userId

  try {
    await sendTyping(chatId)

    // 1. Download voice file from Telegram
    const audioBuffer = await downloadFileAsBuffer(msg.voice!.file_id)
    if (!audioBuffer) {
      await sendMessage(chatId, "Couldn't download voice message. Try again.")
      return
    }

    // 2. Transcribe with Whisper
    const transcript = await transcribeAudio(audioBuffer)
    if (!transcript) {
      await sendMessage(chatId, "Couldn't understand that voice message. Try again or send text.")
      return
    }

    logger.info({ agent: agentName, userId, transcriptLen: transcript.length }, 'Voice transcribed')

    // 3. Escalation check
    const escalation = checkEscalation(transcript)
    if (escalation.tier === 1) {
      logger.warn({ userId, agent: agentName, pattern: escalation.triggerPattern }, 'ESCALATION TIER 1 (voice)')
      await sendMessage(chatId, escalation.messageOverride!)
      return
    }

    // 4. Save user message (note it came from voice)
    saveMessage(userId, agentName, chatId, 'user', transcript)

    // 5. Load brain + history
    const brain = await loadAgentBrain(agentName, userId, transcript)
    const recentMessages = getRecentMessages(userId, agentName, chatId, 6, 48)
    const historyForLLM: ChatMessage[] = recentMessages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }))

    // 6. Call Claude
    let fullResponse = ''
    try {
      for await (const chunk of streamChat(brain, historyForLLM, transcript, agentConfig.model)) {
        fullResponse += chunk
      }
    } catch (err) {
      logger.error({ err, agent: agentName }, 'Claude API call failed (voice)')
      await sendMessage(chatId, 'Sorry, I hit an error. Try again in a moment.')
      return
    }

    // 7. Learning loop
    const cleanedResponse = processResponseLearning(agentName, transcript, fullResponse)

    // 8. Escalation suffix
    let finalResponse = cleanedResponse
    if (escalation.mandatorySuffix) {
      finalResponse += '\n\n' + escalation.mandatorySuffix
    }

    // 9. Generate voice response via TTS
    const voiceBuffer = await generateSpeech(finalResponse)

    // 10. Send voice response (with text fallback)
    if (voiceBuffer) {
      await sendVoiceMessage(chatId, voiceBuffer)
    }
    // Always send text too — voice notes can be hard to hear
    const formatted = formatForTelegram(finalResponse)
    await sendMessage(chatId, formatted)

    // 11. Save assistant message
    saveMessage(userId, agentName, chatId, 'assistant', fullResponse)

    // 12. Background fact extraction
    extractAndStoreFacts(userId, agentName, chatId, agentConfig.displayName)
      .catch(err => logger.error({ err }, 'Background fact extraction failed (voice)'))

    logger.info({
      agent: agentName, userId,
      inputLen: transcript.length, outputLen: fullResponse.length,
      mode: 'voice',
    }, 'Voice message handled')
  } catch (err) {
    logger.error({ err, agent: agentName }, 'Voice message handling failed')
    await sendMessage(chatId, 'Error processing voice message. Try sending text instead.')
  }
}

/**
 * Transcribe audio buffer using OpenAI Whisper API.
 * Accepts .ogg (Telegram voice format) directly.
 */
async function transcribeAudio(audioBuffer: Buffer): Promise<string | null> {
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })
    const file = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' })

    const transcription = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file,
      language: 'en',
    })

    return transcription.text?.trim() || null
  } catch (err) {
    logger.error({ err }, 'Whisper transcription failed')
    return null
  }
}

/**
 * Generate speech from text using OpenAI TTS API.
 * Returns an MP3 buffer ready to send as a Telegram voice note.
 */
async function generateSpeech(text: string): Promise<Buffer | null> {
  try {
    const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY })

    // Truncate to TTS limit (4096 chars) — use a natural break point
    let ttsText = text
    if (ttsText.length > 4000) {
      const cutoff = ttsText.lastIndexOf('.', 4000)
      ttsText = cutoff > 2000 ? ttsText.slice(0, cutoff + 1) : ttsText.slice(0, 4000)
    }

    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'echo',
      input: ttsText,
      response_format: 'mp3',
    })

    return Buffer.from(await response.arrayBuffer())
  } catch (err) {
    logger.error({ err }, 'TTS generation failed')
    return null
  }
}
