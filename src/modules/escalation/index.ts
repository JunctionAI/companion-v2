/**
 * Escalation Engine — Health Safety Floor
 *
 * Runs BEFORE any LLM call. Pure regex, synchronous, $0 cost.
 * Ported from tom-command-center/core/escalation_engine.py
 *
 * 4 tiers:
 *   Tier 1: Emergency — override entire response, tell user to call 111
 *   Tier 2: Urgent GP — agent responds + mandatory 24-48h GP suffix
 *   Tier 3: Routine GP — agent responds + 2-week booking suggestion
 *   Tier 4: Specialist — agent responds + specialist value note
 */

import type { EscalationResult } from '../../types/index.js'

type Pattern = [RegExp, string]

// ─── TIER 1: EMERGENCY (call 111 NOW) ───

const TIER1_PATTERNS: Pattern[] = [
  // Cardiac
  [/chest\s+(pain|pressure|tightness|squeezing|heaviness).{0,60}(arm|jaw|shoulder|neck|radiating|spreading)/i, 'chest pain with radiation'],
  [/(radiating|spreading).{0,40}(chest|arm|jaw|shoulder)/i, 'radiating pain pattern'],
  [/(heart\s+attack|cardiac\s+arrest)/i, 'cardiac emergency keywords'],

  // Breathing
  [/(can'?t\s+breathe|can'?t\s+catch\s+(my\s+)?breath|not\s+breathing|stopped\s+breathing|struggling\s+to\s+breathe).{0,60}(right\s+now|help|emergency|call|please|still|can'?t\s+stop)/i, 'breathing emergency'],
  [/(i\s+)?(am|'?m)\s+(struggling\s+to\s+breathe|not\s+breathing|can'?t\s+breathe)/i, 'breathing emergency present tense'],
  [/(severe|extreme|sudden)\s+(shortness\s+of\s+breath|difficulty\s+breathing)/i, 'severe breathing difficulty'],

  // Stroke (FAST)
  [/(face\s+(drooping|numb|falling)|arm\s+(weak|numb|tingling|falling)|speech\s+(slurred|garbled|lost)|sudden\s+(confusion|vision\s+loss|severe\s+headache))/i, 'stroke symptoms'],
  [/(having\s+a\s+stroke|think\s+(it'?s|i'?m\s+having)\s+a?\s*stroke|tia|transient\s+ischemic)/i, 'stroke keyword'],

  // Suicidal with plan
  [/(want\s+to\s+(kill|end|take)\s+(myself|my\s+life)|going\s+to\s+(kill|end|take)\s+(myself|my\s+life))/i, 'suicidal ideation with intent'],
  [/(have\s+a\s+plan\s+to\s+end|planning\s+to\s+(kill|end)\s+myself|suicide\s+plan)/i, 'suicide plan'],

  // Seizure
  [/(having\s+a\s+seizure|seizure\s+(right\s+now|happening|started)|convuls(ing|ions?))/i, 'active seizure'],

  // Unconscious
  [/(unconscious|unresponsive|won'?t\s+wake\s+up|collapsed\s+(and|not)\s+moving)/i, 'unconscious / collapsed'],

  // Anaphylaxis
  [/(anaphylax|throat\s+(closing|swelling)|tongue\s+swelling|epipen|severe\s+allergic\s+reaction)/i, 'anaphylaxis'],

  // Overdose
  [/(overdos(e|ed|ing)|took\s+too\s+many\s+(pills?|tablets?)|swallowed.{0,30}whole\s+bottle|swallowed.{0,30}all\s+of.{0,20}(pill|tablet|capsule|medication|drug))/i, 'overdose'],
]

// ─── TIER 2: URGENT GP (24-48 hours) ───

const TIER2_PATTERNS: Pattern[] = [
  [/blood\s+in\s+(my\s+)?(stool|poo|poop|faeces|urine|pee|wee|vomit|vomiting|spit)/i, 'blood in excretions'],
  [/(coughing|spitting)\s+up\s+blood/i, 'coughing blood'],
  [/(sudden|worst\s+ever|thunderclap)\s+(severe\s+)?headache/i, 'sudden severe headache'],
  [/(unexplained|sudden|significant)\s+weight\s+loss.{0,30}(kg|kilos?|pounds?)/i, 'unexplained weight loss'],
  [/(sudden|new|rapid)\s+(vision\s+(change|loss|blur|blurry|double)|can'?t\s+see)/i, 'sudden vision change'],
  [/difficulty\s+swallowing.{0,30}(week|getting\s+worse|can'?t\s+eat|solid)/i, 'progressive dysphagia'],
  [/(fever|temperature).{0,40}(3|4|5|6|7)\s*days/i, 'prolonged fever'],
  [/(high\s+fever|fever.{0,20}(39|40|41|42))/i, 'high fever'],
  [/(lump|mass|growth).{0,40}(appeared|new|changed|growing|noticed)/i, 'new lump or growth'],
  [/(severe\s+abdominal|stomach)\s+(pain|cramp).{0,30}(not\s+going\s+away|hours|days)/i, 'severe persistent abdominal pain'],
  [/(yellowing|jaundice).{0,30}(skin|eyes|whites\s+of)/i, 'jaundice'],
]

// ─── TIER 3: ROUTINE GP (within 2 weeks) ───

const TIER3_PATTERNS: Pattern[] = [
  [/(symptom|pain|issue|problem).{0,40}(2|two|3|three|4|four)\s*(weeks?|months?)/i, 'symptoms persisting 2+ weeks'],
  [/(been\s+going\s+on|lasted?|for\s+(over\s+)?).{0,20}(2|two|three|four|five|six)\s*weeks?/i, 'prolonged symptoms'],
  [/(taking|on).{0,30}(medication|meds|prescription|drug).{0,60}(interact|mix|safe\s+with|combine)/i, 'medication interaction concern'],
  [/(changed|changed\s+my|new\s+symptom).{0,40}(diabetes|thyroid|blood\s+pressure|autoimmune|crohn|colitis|ibd|ms\b)/i, 'new symptom with chronic condition'],
  [/(my\s+)?(doctor|gp|specialist)\s+(said|diagnosed|told\s+me).{0,80}(but|however|not\s+sure|confused)/i, 'confusion about existing diagnosis'],
  [/(recurring|keeps\s+coming\s+back|happened\s+before|third\s+time).{0,60}(infection|rash|pain|episode)/i, 'recurring episodes'],
]

// ─── TIER 4: SPECIALIST FLAG ───

const TIER4_PATTERNS: Pattern[] = [
  [/(cardiologist|heart\s+specialist)/i, 'cardiology concern'],
  [/(endocrinologist|hormone\s+specialist|thyroid\s+specialist)/i, 'endocrinology concern'],
  [/(neurologist|brain\s+specialist|nerve\s+specialist)/i, 'neurology concern'],
  [/(rheumatologist|joint\s+specialist|autoimmune\s+specialist)/i, 'rheumatology concern'],
  [/(gastroenterologist|gut\s+specialist|colonoscopy)/i, 'gastroenterology concern'],
]

// ─── Response templates ───

const TIER1_OVERRIDE =
  '🚨 I need to stop you right there.\n\n' +
  'What you\'ve described sounds like it could be a medical emergency. ' +
  'Please call **111** (NZ emergency services) right now, or get someone to take you ' +
  'to your nearest A&E immediately.\n\n' +
  'Do not wait. This is not something I can help you with — you need a doctor now.\n\n' +
  'If you\'re with someone, tell them what\'s happening. If you\'re alone, call 111 first.'

const TIER2_SUFFIX =
  '\n\n⚠️ One thing I want to flag: what you\'ve described is something a GP should look at ' +
  'within the next 24-48 hours. Please don\'t put this off — book in today if you can.'

const TIER3_SUFFIX =
  '\n\n📋 Worth noting: if this is still going on in two weeks, it\'s worth getting it checked ' +
  'with a GP. Symptoms that persist deserve a proper look.'

const TIER4_SUFFIX =
  '\n\n💡 A specialist opinion would add real value here — your GP can refer you if you feel ' +
  'like this needs deeper investigation.'

// ─── Main check function ───

function matchPatterns(text: string, patterns: Pattern[]): string | null {
  for (const [regex, label] of patterns) {
    if (regex.test(text)) return label
  }
  return null
}

export function checkEscalation(messageText: string): EscalationResult {
  const text = messageText.toLowerCase()

  // Tier 1
  const t1 = matchPatterns(text, TIER1_PATTERNS)
  if (t1) return { tier: 1, triggered: true, triggerPattern: t1, messageOverride: TIER1_OVERRIDE }

  // Tier 2
  const t2 = matchPatterns(text, TIER2_PATTERNS)
  if (t2) return { tier: 2, triggered: true, triggerPattern: t2, mandatorySuffix: TIER2_SUFFIX }

  // Tier 3
  const t3 = matchPatterns(text, TIER3_PATTERNS)
  if (t3) return { tier: 3, triggered: true, triggerPattern: t3, mandatorySuffix: TIER3_SUFFIX }

  // Tier 4
  const t4 = matchPatterns(text, TIER4_PATTERNS)
  if (t4) return { tier: 4, triggered: true, triggerPattern: t4, mandatorySuffix: TIER4_SUFFIX }

  return { tier: 0, triggered: false, triggerPattern: '' }
}
