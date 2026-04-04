/**
 * File-Based Brain Loader for Telegram Companion Agents
 *
 * Ported from tom-command-center/core/orchestrator.py load_agent_brain()
 * Reads agent files in priority order and assembles into 3-block BrainOutput
 * for Anthropic two-tier prompt caching.
 */

import { readFileSync, readdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'
import { retrieveUserFacts } from '../memory/retrieve.js'
import { loadUserMemory } from '../memory/sqlite.js'
import { loadMetricsContext, loadBiomarkerContext } from '../metrics/index.js'
import type { BrainOutput } from '../../types/index.js'

const AGENTS_DIR = resolve(import.meta.dirname, '../../../agents')

function readFileSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
  } catch {
    return null
  }
}

function readDirFiles(dirPath: string): string[] {
  try {
    if (!existsSync(dirPath)) return []
    return readdirSync(dirPath)
      .filter(f => f.endsWith('.md'))
      .sort()
      .map(f => readFileSafe(join(dirPath, f)))
      .filter((c): c is string => c !== null)
  } catch {
    return []
  }
}

function nowNZ(): string {
  const now = new Date()
  const formatted = now.toLocaleString('en-NZ', {
    timeZone: env.TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return formatted
}

function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })
}

/**
 * Load the full agent brain from files + memory systems.
 *
 * Returns a 3-block BrainOutput:
 * - staticBlock: Agent identity + health framework (cached, same for all convos)
 * - semiStaticBlock: User knowledge + plans (cached, changes weekly)
 * - dynamicBlock: Date + session logs + recent context (never cached)
 */
export async function loadAgentBrain(
  agentName: string,
  userId: string,
  currentMessage: string,
): Promise<BrainOutput> {
  const agentDir = join(AGENTS_DIR, agentName)

  // ─── STATIC BLOCK (cached across all conversations) ───
  const staticParts: string[] = []

  // 1. AGENT.md — identity + instructions
  const agentMd = readFileSafe(join(agentDir, 'AGENT.md'))
  if (agentMd) staticParts.push(agentMd)

  // 2. Health reasoning framework (shared across all companions)
  const healthReasoning = readFileSafe(join(AGENTS_DIR, 'shared', 'health-reasoning.md'))
  if (healthReasoning) staticParts.push(healthReasoning)

  // 3. Training files (deep domain knowledge — rarely changes)
  const trainingFiles = readDirFiles(join(agentDir, 'training'))
  if (trainingFiles.length > 0) {
    staticParts.push('=== TRAINING & DOMAIN KNOWLEDGE ===')
    staticParts.push(...trainingFiles)
  }

  // 4. Skills (general best practice)
  const skillFiles = readDirFiles(join(agentDir, 'skills'))
  if (skillFiles.length > 0) {
    staticParts.push('=== SKILLS ===')
    staticParts.push(...skillFiles)
  }

  // 5. Playbooks (highest priority — proven patterns)
  const playbookFiles = readDirFiles(join(agentDir, 'playbooks'))
  if (playbookFiles.length > 0) {
    staticParts.push('=== PLAYBOOKS (HIGHEST PRIORITY — PROVEN WITH DATA) ===')
    staticParts.push(...playbookFiles)
  }

  // ─── SEMI-STATIC BLOCK (cached per user, changes weekly) ───
  const semiStaticParts: string[] = []

  // 6. Persistent knowledge about this user
  const knowledge = readFileSafe(join(agentDir, 'knowledge.md'))
  if (knowledge) {
    semiStaticParts.push('=== PERSISTENT KNOWLEDGE ===')
    semiStaticParts.push(knowledge)
  }

  // 7. Health brief (generated from intake)
  const healthBrief = readFileSafe(join(agentDir, 'state', 'HEALTH_BRIEF.md'))
  if (healthBrief) {
    semiStaticParts.push('=== HEALTH BRIEF ===')
    semiStaticParts.push(healthBrief.slice(0, 3000))
  }

  // 8. Current plan (overrides skill templates)
  const currentPlan = readFileSafe(join(agentDir, 'state', 'CURRENT_PLAN.md'))
  if (currentPlan) {
    semiStaticParts.push('=== CURRENT PLAN (ACTIVE — OVERRIDES SKILL TEMPLATES) ===')
    semiStaticParts.push(currentPlan)
  }

  // 9. User memory from SQLite (permanent facts + session summaries)
  const sqliteMemory = loadUserMemory(userId, agentName)
  if (sqliteMemory) {
    semiStaticParts.push(sqliteMemory)
  }

  // 10. Biomarker results (blood tests)
  const biomarkerCtx = loadBiomarkerContext(userId)
  if (biomarkerCtx) semiStaticParts.push(biomarkerCtx)

  // 11. Tracked health metrics (sleep, HRV, mood, etc.)
  const metricsCtx = loadMetricsContext(userId)
  if (metricsCtx) semiStaticParts.push(metricsCtx)

  // 12. User facts from Neo4j (if available — gracefully degrades)
  try {
    const neo4jFacts = await retrieveUserFacts(currentMessage, userId)
    if (neo4jFacts.length > 0) {
      semiStaticParts.push('=== NEO4J MEMORY GRAPH ===')
      for (const fact of neo4jFacts) {
        semiStaticParts.push(`- [${fact.category}] ${fact.text}`)
      }
    }
  } catch {
    // Neo4j unavailable — non-fatal
  }

  // ─── DYNAMIC BLOCK (never cached — changes every message) ───
  const dynamicParts: string[] = []

  // 11. Current date/time (prevents temporal confusion)
  dynamicParts.push(`Current date and time: ${nowNZ()}`)

  // 12. State/CONTEXT.md (rolling log)
  const context = readFileSafe(join(agentDir, 'state', 'CONTEXT.md'))
  if (context) {
    dynamicParts.push('=== CURRENT CONTEXT ===')
    dynamicParts.push(context)
  }

  // 13. Session logs (today + last 7 days)
  const today = todayISO()
  const sessionLogParts: string[] = []

  // Today's log first
  const todayLog = readFileSafe(join(agentDir, 'state', `session-log-${today}.md`))
  if (todayLog) {
    const trimmed = todayLog.length > 2000 ? todayLog.slice(0, 2000) : todayLog
    sessionLogParts.push(`--- TODAY (${today}) ---\n${trimmed}`)
  }

  // Last 7 days
  for (let daysBack = 1; daysBack <= 7; daysBack++) {
    const date = new Date(Date.now() - daysBack * 86400_000)
    const dateStr = date.toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })
    const log = readFileSafe(join(agentDir, 'state', `session-log-${dateStr}.md`))
    if (log) {
      const trimmed = log.length > 1500 ? log.slice(0, 1500) : log
      sessionLogParts.push(`--- ${dateStr} ---\n${trimmed}`)
    }
  }

  if (sessionLogParts.length > 0) {
    dynamicParts.push('=== RECENT SESSION HISTORY ===')
    dynamicParts.push(...sessionLogParts)
  }

  const output: BrainOutput = {
    staticBlock: staticParts.join('\n\n'),
    semiStaticBlock: semiStaticParts.join('\n\n'),
    dynamicBlock: dynamicParts.join('\n\n'),
  }

  logger.info({
    agent: agentName,
    userId,
    staticLen: output.staticBlock.length,
    semiStaticLen: output.semiStaticBlock.length,
    dynamicLen: output.dynamicBlock.length,
    estimatedTokens: Math.round((output.staticBlock.length + output.semiStaticBlock.length + output.dynamicBlock.length) / 4),
  }, 'Agent brain loaded')

  return output
}

/**
 * Load a scheduled task prompt from agents/{name}/prompts/{task}.md
 */
export function loadTaskPrompt(agentName: string, taskName: string): string | null {
  const promptFile = join(AGENTS_DIR, agentName, 'prompts', `${taskName}.md`)
  return readFileSafe(promptFile)
}
