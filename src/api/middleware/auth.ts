import type { Request, Response, NextFunction } from 'express'
import { supabase } from '../../lib/supabase.js'
import { logger } from '../../lib/logger.js'

export interface AuthRequest extends Request {
  userId?: string
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }

  const token = authHeader.split(' ')[1]
  const { data, error } = await supabase.auth.getUser(token)

  if (error || !data.user) {
    logger.warn({ error }, 'Auth failed')
    res.status(401).json({ error: 'Invalid token' })
    return
  }

  req.userId = data.user.id
  next()
}
