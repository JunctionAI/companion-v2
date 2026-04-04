/**
 * Cron Scheduler — Runs scheduled check-ins for companion agents
 *
 * Uses simple setInterval-based scheduling with cron expression parsing.
 * All times in NZ timezone (Pacific/Auckland).
 */

import { SCHEDULES } from '../config/telegram.js'
import { env } from '../config/env.js'
import { runScheduledTask } from '../transport/telegram.js'
import { logger } from '../lib/logger.js'

interface ParsedSchedule {
  agent: string
  task: string
  hour: number
  minute: number
}

function parseCron(cron: string): { minute: number; hour: number } | null {
  // Simple cron: "M H * * *" — we only support exact hour/minute
  const parts = cron.split(' ')
  if (parts.length < 5) return null
  const minute = parseInt(parts[0], 10)
  const hour = parseInt(parts[1], 10)
  if (isNaN(minute) || isNaN(hour)) return null
  return { minute, hour }
}

let checkInterval: ReturnType<typeof setInterval> | null = null
const lastRunKey = new Map<string, string>() // "agent:task" → "YYYY-MM-DD HH:MM"

/**
 * Start the scheduler. Checks every 30 seconds if any task should fire.
 */
export function startScheduler() {
  const parsed: ParsedSchedule[] = []
  for (const s of SCHEDULES) {
    const time = parseCron(s.cron)
    if (time) {
      parsed.push({ agent: s.agent, task: s.task, hour: time.hour, minute: time.minute })
    }
  }

  logger.info({ taskCount: parsed.length }, 'Scheduler started')

  // Check every 30 seconds
  checkInterval = setInterval(() => {
    const now = new Date()
    const nzHour = parseInt(now.toLocaleString('en-US', { timeZone: env.TIMEZONE, hour: '2-digit', hour12: false }), 10)
    const nzMinute = parseInt(now.toLocaleString('en-US', { timeZone: env.TIMEZONE, minute: '2-digit' }), 10)
    const nzDate = now.toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })

    for (const s of parsed) {
      if (s.hour === nzHour && s.minute === nzMinute) {
        const key = `${s.agent}:${s.task}`
        const runKey = `${nzDate} ${s.hour}:${s.minute}`

        // Don't run same task twice in same minute
        if (lastRunKey.get(key) === runKey) continue
        lastRunKey.set(key, runKey)

        logger.info({ agent: s.agent, task: s.task }, 'Firing scheduled task')
        runScheduledTask(s.agent, s.task).catch(err => {
          logger.error({ err, agent: s.agent, task: s.task }, 'Scheduled task error')
        })
      }
    }
  }, 30_000)
}

export function stopScheduler() {
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}
