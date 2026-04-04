/**
 * Telegram Onboarding — First-message questionnaire
 *
 * When a message arrives from an unregistered chat, run a multi-step
 * questionnaire to collect user info, then generate agent files from template.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync, readdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { sendMessage } from '../../lib/telegram.js'
import { registerAgent, AUTHORIZED_USERS } from '../../config/telegram.js'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'

const ROOT = resolve(import.meta.dirname, '../../../')
const TEMPLATE_DIR = join(ROOT, 'agents', '_template')
const AGENTS_DIR = join(ROOT, 'agents')
const CONFIG_PATH = join(ROOT, 'config', 'agents.json')

interface OnboardingSession {
  step: number
  chatId: string
  senderId: string
  data: {
    name?: string
    age?: string
    goals?: string
    medical?: string
    activity?: string
  }
}

// In-memory onboarding sessions (keyed by chatId)
const sessions = new Map<string, OnboardingSession>()

const STEPS = [
  { key: 'name', prompt: "Hey! I'm your new health companion. Let's get you set up — takes about 60 seconds.\n\nWhat's your first name?" },
  { key: 'age', prompt: 'How old are you?' },
  { key: 'goals', prompt: "What are your top health goals? (e.g., better sleep, lose weight, build muscle, reduce stress)" },
  { key: 'medical', prompt: "Any medical conditions, allergies, or medications I should know about?\n\n(Type 'none' if not applicable)" },
  { key: 'activity', prompt: "What's your current activity level?\n\n1. Sedentary\n2. Lightly active (1-2x/week)\n3. Moderately active (3-4x/week)\n4. Very active (5+/week)\n5. Athlete\n\n(Send a number or describe it)" },
] as const

const ACTIVITY_MAP: Record<string, string> = {
  '1': 'Sedentary (desk job, little exercise)',
  '2': 'Lightly active (1-2 sessions/week)',
  '3': 'Moderately active (3-4 sessions/week)',
  '4': 'Very active (5+ sessions/week)',
  '5': 'Athlete (daily training)',
}

/**
 * Check if a chat has a pending onboarding session.
 */
export function hasOnboardingSession(chatId: string): boolean {
  return sessions.has(chatId)
}

/**
 * Start onboarding for a new chat. Returns true if onboarding was started.
 */
export async function startOnboarding(chatId: string, senderId: string): Promise<boolean> {
  // Only allow authorized users to onboard
  const isOwner = senderId === env.TELEGRAM_OWNER_ID
  const isAuthorized = AUTHORIZED_USERS.includes(senderId)
  if (!isOwner && !isAuthorized) {
    await sendMessage(chatId, "You're not authorized to set up a companion here. Ask the bot owner to add your Telegram user ID to the authorized users list.")
    return false
  }

  sessions.set(chatId, {
    step: 0,
    chatId,
    senderId,
    data: {},
  })

  await sendMessage(chatId, STEPS[0].prompt)
  return true
}

/**
 * Process a message during onboarding. Returns true if still onboarding.
 */
export async function processOnboardingMessage(chatId: string, text: string): Promise<boolean> {
  const session = sessions.get(chatId)
  if (!session) return false

  const currentStep = STEPS[session.step]

  // Store answer
  let value = text.trim()
  if (currentStep.key === 'activity' && ACTIVITY_MAP[value]) {
    value = ACTIVITY_MAP[value]
  }
  ;(session.data as Record<string, string>)[currentStep.key] = value

  // Advance to next step
  session.step++

  if (session.step < STEPS.length) {
    // Ask next question
    await sendMessage(chatId, STEPS[session.step].prompt)
    return true
  }

  // All steps complete — generate agent
  try {
    await generateAgent(session)
    sessions.delete(chatId)
    return false // Onboarding complete
  } catch (err) {
    logger.error({ err, chatId }, 'Onboarding agent generation failed')
    await sendMessage(chatId, 'Something went wrong during setup. Please try again by sending any message.')
    sessions.delete(chatId)
    return false
  }
}

async function generateAgent(session: OnboardingSession) {
  const { name, age, goals, medical, activity } = session.data
  if (!name) throw new Error('Missing name')

  const agentName = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-companion'
  const userId = name.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const displayName = name + "'s Companion"
  const agentDir = join(AGENTS_DIR, agentName)

  // Copy template
  if (!existsSync(agentDir)) {
    cpSync(TEMPLATE_DIR, agentDir, { recursive: true })
  }

  // Replace placeholders
  const today = new Date().toISOString().split('T')[0]
  const replacements: Record<string, string> = {
    '{{DISPLAY_NAME}}': displayName,
    '{{USER_NAME}}': name,
    '{{AGE}}': age || 'Not specified',
    '{{TIMEZONE}}': env.TIMEZONE,
    '{{GOALS}}': goals ? goals.split(',').map(g => `- ${g.trim()}`).join('\n') : '- General health improvement',
    '{{MEDICAL_CONTEXT}}': (!medical || medical.toLowerCase() === 'none') ? 'No known conditions.' : medical,
    '{{ACTIVITY_LEVEL}}': activity || 'Not specified',
    '{{DATE}}': today,
  }

  replaceInDir(agentDir, replacements)

  // Register agent
  const agentConfig = {
    name: agentName,
    chatId: session.chatId,
    userId,
    displayName,
    model: 'sonnet' as const,
  }

  registerAgent(agentConfig)

  // Add default schedules
  addSchedules(agentName)

  // Ensure data dir
  mkdirSync(join(ROOT, 'data'), { recursive: true })

  logger.info({ agent: agentName, userId, chatId: session.chatId }, 'Onboarding complete — agent created')

  await sendMessage(session.chatId,
    `You're all set, ${name}! I'm your health companion now.\n\n` +
    `Here's what happens next:\n` +
    `- I'll check in every morning at 8am and evening at 7pm\n` +
    `- Message me anytime with questions about health, training, nutrition, or how you're feeling\n` +
    `- I learn about you over time — the more we talk, the better I get\n\n` +
    `Commands:\n` +
    `/memory — see what I remember about you\n` +
    `/forget <text> — make me forget something\n\n` +
    `Try sending me a message now — tell me about your current health situation.`
  )
}

function addSchedules(agentName: string) {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
    const existing = config.schedules.filter((s: { agent: string }) => s.agent === agentName)
    if (existing.length === 0) {
      config.schedules.push(
        { agent: agentName, task: 'morning_checkin', cron: '0 8 * * *' },
        { agent: agentName, task: 'evening_checkin', cron: '0 19 * * *' },
      )
      writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf-8')
    }
  } catch (err) {
    logger.error({ err, agentName }, 'Failed to add schedules')
  }
}

function replaceInDir(dir: string, replacements: Record<string, string>) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      replaceInDir(fullPath, replacements)
    } else if (entry.endsWith('.md')) {
      let content = readFileSync(fullPath, 'utf-8')
      for (const [placeholder, value] of Object.entries(replacements)) {
        content = content.replaceAll(placeholder, value)
      }
      writeFileSync(fullPath, content, 'utf-8')
    }
  }
}
