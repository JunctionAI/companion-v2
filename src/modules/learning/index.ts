/**
 * Learning Loop — Post-response processing
 *
 * After every agent response:
 * 1. Extract markers ([STATE UPDATE:], [INSIGHT:], etc.)
 * 2. Append to session log
 * 3. Update CONTEXT.md (rolling 20 entries)
 * 4. Clean markers from response (for Telegram delivery)
 *
 * Ported from orchestrator.py process_response_learning() + extract_markers_from_response()
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve } from 'path'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'

const AGENTS_DIR = resolve(import.meta.dirname, '../../../agents')

// ─── Marker Patterns ───

const MARKER_PATTERNS = {
  metrics: /\[METRIC:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g,
  insights: /\[INSIGHT:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g,
  stateUpdates: /\[STATE UPDATE:\s*([^\]]+)\]/g,
  events: /\[EVENT:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g,
  tasks: /\[TASK:\s*([^|]+)\|([^|]+)\|([^\]]+)\]/g,
}

export interface ExtractedMarkers {
  metrics: Array<{ name: string; value: string; context: string }>
  insights: Array<{ category: string; content: string; evidence: string }>
  stateUpdates: string[]
  events: Array<{ type: string; severity: string; payload: string }>
  tasks: Array<{ title: string; priority: string; description: string }>
}

export function extractMarkers(response: string): ExtractedMarkers {
  const markers: ExtractedMarkers = {
    metrics: [],
    insights: [],
    stateUpdates: [],
    events: [],
    tasks: [],
  }

  for (const match of response.matchAll(MARKER_PATTERNS.metrics)) {
    markers.metrics.push({ name: match[1].trim(), value: match[2].trim(), context: match[3].trim() })
  }
  for (const match of response.matchAll(MARKER_PATTERNS.insights)) {
    markers.insights.push({ category: match[1].trim(), content: match[2].trim(), evidence: match[3].trim() })
  }
  for (const match of response.matchAll(MARKER_PATTERNS.stateUpdates)) {
    markers.stateUpdates.push(match[1].trim())
  }
  for (const match of response.matchAll(MARKER_PATTERNS.events)) {
    markers.events.push({ type: match[1].trim(), severity: match[2].trim(), payload: match[3].trim() })
  }
  for (const match of response.matchAll(MARKER_PATTERNS.tasks)) {
    markers.tasks.push({ title: match[1].trim(), priority: match[2].trim(), description: match[3].trim() })
  }

  return markers
}

/** Remove all marker tags from response text (for Telegram delivery) */
export function cleanMarkers(response: string): string {
  return response
    .replace(/\[INSIGHT:[^\]]+\]/g, '')
    .replace(/\[DECISION:[^\]]+\]/g, '')
    .replace(/\[METRIC:[^\]]+\]/g, '')
    .replace(/\[STATE UPDATE:[^\]]+\]/g, '')
    .replace(/\[EVENT:[^\]]+\]/g, '')
    .replace(/\[TASK:[^\]]+\]/g, '')
    .replace(/\[VERIFY:[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function nowNZFormatted(): string {
  return new Date().toLocaleString('en-NZ', {
    timeZone: env.TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function todayISO(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })
}

/** Append conversation turn to session log file */
export function appendToSessionLog(
  agentName: string,
  userMessage: string,
  agentResponse: string,
  markers: ExtractedMarkers,
) {
  const stateDir = join(AGENTS_DIR, agentName, 'state')
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })

  const logFile = join(stateDir, `session-log-${todayISO()}.md`)
  const timestamp = nowNZFormatted()

  let entry = `\n## ${timestamp}\n`
  entry += `**User:** ${userMessage.slice(0, 500)}\n\n`

  if (markers.stateUpdates.length > 0) {
    entry += `**State Updates:**\n`
    for (const su of markers.stateUpdates) entry += `- ${su}\n`
    entry += '\n'
  }
  if (markers.insights.length > 0) {
    entry += `**Insights:**\n`
    for (const i of markers.insights) entry += `- [${i.category}] ${i.content}\n`
    entry += '\n'
  }

  entry += `**Agent:** ${agentResponse.slice(0, 1000)}\n\n---\n`

  try {
    const existing = existsSync(logFile) ? readFileSync(logFile, 'utf-8') : `# Session Log — ${todayISO()}\n`
    writeFileSync(logFile, existing + entry, 'utf-8')
  } catch (err) {
    logger.error({ err, agentName }, 'Failed to write session log')
  }
}

/** Update CONTEXT.md with rolling 20-entry window */
export function updateAgentState(agentName: string, newInfo: string) {
  const contextFile = join(AGENTS_DIR, agentName, 'state', 'CONTEXT.md')
  if (!existsSync(contextFile)) return

  try {
    const content = readFileSync(contextFile, 'utf-8')
    const timestamp = nowNZFormatted()
    const newEntry = `- [${timestamp}] ${newInfo.slice(0, 500)}`

    // Split into foundation + live updates
    const liveMarker = '## LIVE UPDATES'
    const markerIdx = content.indexOf(liveMarker)

    let foundation: string
    let updates: string[]

    if (markerIdx >= 0) {
      foundation = content.slice(0, markerIdx)
      const liveSection = content.slice(markerIdx + liveMarker.length)
      updates = liveSection.split('\n').filter(l => l.startsWith('- ['))
    } else {
      foundation = content
      updates = []
    }

    // Update "Last Updated" line
    foundation = foundation.replace(
      /## Last Updated:.*\n/,
      `## Last Updated: ${timestamp}\n`,
    )

    // Add new entry, keep max 20
    updates.unshift(newEntry)
    updates = updates.slice(0, 20)

    const rebuilt = `${foundation.trimEnd()}\n\n${liveMarker}\n${updates.join('\n')}\n`
    writeFileSync(contextFile, rebuilt, 'utf-8')
  } catch (err) {
    logger.error({ err, agentName }, 'Failed to update CONTEXT.md')
  }
}

/**
 * Full post-response learning pipeline.
 * Returns cleaned response (markers stripped).
 */
export function processResponseLearning(
  agentName: string,
  userMessage: string,
  response: string,
): string {
  const markers = extractMarkers(response)

  // Append to session log
  appendToSessionLog(agentName, userMessage, response, markers)

  // Update CONTEXT.md if there are state updates
  for (const su of markers.stateUpdates) {
    updateAgentState(agentName, su)
  }

  // Log marker stats
  const markerCount = markers.metrics.length + markers.insights.length +
    markers.stateUpdates.length + markers.events.length + markers.tasks.length
  if (markerCount > 0) {
    logger.info({
      agent: agentName,
      metrics: markers.metrics.length,
      insights: markers.insights.length,
      stateUpdates: markers.stateUpdates.length,
      events: markers.events.length,
      tasks: markers.tasks.length,
    }, 'Markers extracted from response')
  }

  return cleanMarkers(response)
}
