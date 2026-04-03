/**
 * Brain Builder — Pure function that assembles the system prompt.
 *
 * NO database calls inside this function. All inputs are pre-fetched and passed in.
 * Returns three blocks for Anthropic's two-tier prompt caching:
 *
 *   1. staticBlock  — Agent identity, health framework, playbooks (~5000 tokens, CACHED)
 *   2. semiStaticBlock — User health brief, plan phase, knowledge (~2000 tokens, CACHED)
 *   3. dynamicBlock — Date, summaries, recent messages, medical context (~1500 tokens, NOT cached)
 */

import type { BrainInput, BrainOutput } from '../../types/index.js'

// ─── Static content (loaded once at startup, never changes between calls) ───

const AGENT_IDENTITY = `You are a personal health intelligence companion. You help users understand their health data, track progress toward goals, and make informed decisions about nutrition, exercise, sleep, and supplements.

You are warm, knowledgeable, and evidence-focused. Like a health-literate friend who happens to have deep science knowledge. Encouraging but honest. You grade evidence when relevant: (meta-analysis), (RCT), (observational), (preclinical).

You are NOT a doctor. You always encourage professional medical consultation for clinical decisions. You never diagnose conditions — use phrases like "this could be consistent with" or "worth discussing with your GP." You never recommend stopping prescribed medications. For supplements, you may suggest evidence-based options with standard dosage ranges, noting "check with your pharmacist about interactions."

NZ context: emergency number is 111 (not 911). Healthline: 0800 611 116. Mental health crisis: call or text 1737.`

const HEALTH_REASONING_FRAMEWORK = `=== HEALTH REASONING FRAMEWORK ===
When responding to health questions, follow this decision algorithm:

TIER 0 (ROUTINE): Sneezing, runny nose, minor aches, common colds, seasonal allergies, mild headaches, general fatigue, muscle soreness from exercise.
→ Respond conversationally. Offer practical suggestions. No escalation language.

TIER 1 (MONITOR): Persistent symptoms (>1 week), unusual patterns, moderate discomfort.
→ Acknowledge, provide evidence-based suggestions, note "if this continues beyond 2 weeks, worth a GP visit."

TIER 2 (GP RECOMMENDED): Symptoms >2 weeks, medication concerns, new symptoms with chronic conditions.
→ Respond fully but include GP recommendation.

TIER 3 (URGENT): Sudden onset severe symptoms, blood in excretions, high fever >3 days.
→ Respond but with strong GP-within-48-hours language.

DEFAULT TO TIER 0. Most health questions are routine. Do not over-escalate.`

const RESPONSE_STYLE = `=== RESPONSE STYLE ===
- Keep responses concise (2-4 paragraphs) unless depth is requested
- Personalize based on the user's specific profile, conditions, goals, and medications
- When the user logs data, acknowledge and contextualize against their goals
- Use **bold** for emphasis, bullet lists for actionable items
- Be direct and candid — don't sugarcoat, but be kind`

// ─── Builder ───

function buildStaticBlock(): string {
  return [AGENT_IDENTITY, HEALTH_REASONING_FRAMEWORK, RESPONSE_STYLE].join('\n\n')
}

function buildSemiStaticBlock(input: BrainInput): string {
  const parts: string[] = []

  if (input.profile) {
    const p = input.profile
    const age = p.date_of_birth
      ? Math.floor((Date.now() - new Date(p.date_of_birth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
      : 'Unknown'

    parts.push(`=== USER HEALTH PROFILE ===
Age: ${age}
Sex: ${p.sex || 'Not specified'}
Height: ${p.height_cm ? `${p.height_cm} cm` : 'Not specified'}
Weight: ${p.weight_kg ? `${p.weight_kg} kg` : 'Not specified'}
Blood Type: ${p.blood_type || 'Not specified'}
Activity Level: ${p.activity_level || 'Not specified'}
Diet: ${p.diet_preference || 'Not specified'}
Conditions: ${p.conditions.length ? p.conditions.join(', ') : 'None reported'}
Medications: ${p.medications.length ? p.medications.join(', ') : 'None reported'}
Supplements: ${p.supplements.length ? p.supplements.join(', ') : 'None reported'}
Allergies: ${p.allergies.length ? p.allergies.join(', ') : 'None reported'}`)
  }

  if (input.goals.length > 0) {
    const active = input.goals.filter(g => g.status === 'active')
    if (active.length > 0) {
      parts.push('=== ACTIVE HEALTH GOALS ===\n' +
        active.map(g => {
          const progress = g.current_value != null && g.target_value != null
            ? ` (${g.current_value}${g.unit || ''} → ${g.target_value}${g.unit || ''})`
            : ''
          return `- ${g.title} [${g.category}]${progress}`
        }).join('\n'))
    }
  }

  if (input.userFacts.length > 0) {
    const byCategory = new Map<string, typeof input.userFacts>()
    for (const fact of input.userFacts) {
      const list = byCategory.get(fact.category) || []
      list.push(fact)
      byCategory.set(fact.category, list)
    }

    const lines = ['=== WHAT YOU KNOW ABOUT THIS USER ===']
    for (const [cat, facts] of [...byCategory.entries()].sort()) {
      lines.push(`\n[${cat}]`)
      for (const f of facts) {
        lines.push(`- ${f.text} (confidence: ${f.confidence.toFixed(2)})`)
      }
    }
    parts.push(lines.join('\n'))
  }

  return parts.join('\n\n')
}

function buildDynamicBlock(input: BrainInput): string {
  const parts: string[] = []

  parts.push(`Current date/time: ${input.currentDate}`)

  if (input.sessionSummaries.length > 0) {
    parts.push('=== RECENT SESSION SUMMARIES ===\n' + input.sessionSummaries.join('\n\n'))
  }

  if (input.medicalContext) {
    parts.push(`=== MEDICAL CONTEXT ===\n${input.medicalContext}`)
  }

  return parts.join('\n\n')
}

export function buildBrain(input: BrainInput): BrainOutput {
  return {
    staticBlock: buildStaticBlock(),
    semiStaticBlock: buildSemiStaticBlock(input),
    dynamicBlock: buildDynamicBlock(input),
  }
}
