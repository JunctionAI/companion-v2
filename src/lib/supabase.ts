import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'
import { logger } from './logger.js'

let supabase: SupabaseClient | null = null
let supabaseAnon: SupabaseClient | null = null

if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY && env.SUPABASE_ANON_KEY) {
  supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
  supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
  logger.info('Supabase clients initialised')
} else {
  logger.info('Supabase not configured — web API will be unavailable')
}

export { supabase, supabaseAnon }
