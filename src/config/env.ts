import { z } from 'zod'
import 'dotenv/config'

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  TIMEZONE: z.string().default('UTC'),

  // Anthropic (required)
  ANTHROPIC_API_KEY: z.string().min(1),

  // Telegram (required)
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.string().min(1),

  // Supabase (optional — only needed for web API)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),

  // Neo4j (optional — SQLite is primary, Neo4j adds graph memory)
  NEO4J_URI: z.string().min(1).optional(),
  NEO4J_USERNAME: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1).optional(),

  // Redis (optional — only needed for BullMQ)
  REDIS_URL: z.string().optional(),

  // OpenAI (optional — Whisper for voice transcription)
  OPENAI_API_KEY: z.string().default(''),
})

export const env = envSchema.parse(process.env)
export type Env = z.infer<typeof envSchema>
