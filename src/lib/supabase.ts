import { createClient } from '@supabase/supabase-js'
import { env } from '../config/env.js'

// Service client — bypasses RLS, used server-side only
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)

// Anon client — respects RLS, used for user-context queries
export const supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
