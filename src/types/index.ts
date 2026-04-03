// ─── User & Profile ───

export interface User {
  id: string
  email: string
  name: string
  timezone: string
  onboarding_complete: boolean
}

export interface HealthProfile {
  user_id: string
  date_of_birth?: string
  sex?: string
  height_cm?: number
  weight_kg?: number
  blood_type?: string
  conditions: string[]
  medications: string[]
  supplements: string[]
  allergies: string[]
  activity_level?: string
  diet_preference?: string
}

export interface HealthGoal {
  id: string
  user_id: string
  title: string
  category: string
  current_value?: number
  target_value?: number
  unit?: string
  target_date?: string
  status: 'active' | 'completed' | 'paused'
}

// ─── Chat ───

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// ─── Escalation ───

export interface EscalationResult {
  tier: 0 | 1 | 2 | 3 | 4
  triggered: boolean
  triggerPattern: string
  messageOverride?: string    // Tier 1: replaces entire response
  mandatorySuffix?: string    // Tier 2-4: appended to response
}

// ─── Brain Builder ───

export interface BrainInput {
  profile: HealthProfile | null
  goals: HealthGoal[]
  recentMessages: ChatMessage[]
  sessionSummaries: string[]
  userFacts: UserFact[]
  medicalContext?: string
  currentDate: string
}

export interface BrainOutput {
  /** Static block — agent identity, health framework, playbooks. Cached via Anthropic. */
  staticBlock: string
  /** Semi-static block — user health brief, plan phase, persistent knowledge. Cached. */
  semiStaticBlock: string
  /** Dynamic tail — date, summaries, recent messages, medical context. Not cached. */
  dynamicBlock: string
}

// ─── Memory (Neo4j) ───

export interface UserFact {
  text: string
  category: 'biographical' | 'goal' | 'constraint' | 'preference' | 'pattern' | 'decision' | 'event'
  confidence: number
  updated_at?: string
}

// ─── LLM Router ───

export type ModelChoice = 'haiku' | 'sonnet' | 'opus'

export interface LLMRequest {
  brain: BrainOutput
  messages: ChatMessage[]
  userMessage: string
  model: ModelChoice
}
