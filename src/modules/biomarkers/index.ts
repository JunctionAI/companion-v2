/**
 * Blood Test / Biomarker Parser
 *
 * Handles photo/document messages containing blood test results:
 * 1. Download file from Telegram
 * 2. Send to Claude Vision for extraction
 * 3. Parse into structured data
 * 4. Store in SQLite biomarker_results table
 * 5. Generate interpretation message
 */

import Anthropic from '@anthropic-ai/sdk'
import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { EXTRACTION_PROMPT, interpretationPrompt } from './prompts.js'

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

export interface BiomarkerResult {
  test_name: string
  value: number
  unit: string
  reference_low: number | null
  reference_high: number | null
  flag: 'normal' | 'low' | 'high' | 'critical'
}

/**
 * Extract biomarker results from an image (base64 encoded).
 */
export async function extractFromImage(imageBase64: string, mediaType: string): Promise<BiomarkerResult[]> {
  logger.info('Extracting biomarkers from image via Claude Vision')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''

  try {
    // Try to parse JSON from the response (may be wrapped in markdown code blocks)
    const jsonStr = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const results = JSON.parse(jsonStr) as BiomarkerResult[]
    logger.info({ resultCount: results.length }, 'Biomarkers extracted successfully')
    return results
  } catch (err) {
    logger.error({ err, rawText: text.slice(0, 500) }, 'Failed to parse biomarker JSON')
    return []
  }
}

/**
 * Extract biomarker results from a text paste of blood test data.
 */
export async function extractFromText(text: string): Promise<BiomarkerResult[]> {
  logger.info('Extracting biomarkers from text via Claude')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `${EXTRACTION_PROMPT}\n\nHere are the blood test results:\n\n${text}`,
      },
    ],
  })

  const responseText = response.content[0].type === 'text' ? response.content[0].text : ''

  try {
    const jsonStr = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const results = JSON.parse(jsonStr) as BiomarkerResult[]
    logger.info({ resultCount: results.length }, 'Biomarkers extracted from text')
    return results
  } catch (err) {
    logger.error({ err }, 'Failed to parse biomarker JSON from text')
    return []
  }
}

/**
 * Generate a plain-language interpretation of blood test results.
 */
export async function interpretResults(
  userName: string,
  results: BiomarkerResult[],
): Promise<string> {
  const resultsText = results.map(r => {
    const flag = r.flag !== 'normal' ? ` [${r.flag.toUpperCase()}]` : ''
    const range = r.reference_low !== null && r.reference_high !== null
      ? ` (ref: ${r.reference_low}-${r.reference_high})`
      : ''
    return `- ${r.test_name}: ${r.value} ${r.unit}${range}${flag}`
  }).join('\n')

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: 'You are a health companion — rigorous, mechanism-first, evidence-based. Never use tables. Use bullets and label:value format.',
    messages: [
      {
        role: 'user',
        content: interpretationPrompt(userName, resultsText),
      },
    ],
  })

  return response.content[0].type === 'text' ? response.content[0].text : ''
}

/**
 * Format results as a summary string for storage in agent context.
 */
export function formatResultsSummary(results: BiomarkerResult[]): string {
  if (results.length === 0) return ''

  const flagged = results.filter(r => r.flag !== 'normal')
  const normal = results.filter(r => r.flag === 'normal')

  let summary = `Blood test: ${results.length} markers tested`
  if (flagged.length > 0) {
    summary += `\nFlagged (${flagged.length}):`
    for (const r of flagged) {
      summary += `\n  ${r.test_name}: ${r.value} ${r.unit} [${r.flag}]`
    }
  }
  if (normal.length > 0) {
    summary += `\nNormal (${normal.length}): ${normal.map(r => r.test_name).join(', ')}`
  }
  return summary
}
