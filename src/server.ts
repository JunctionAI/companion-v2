import express from 'express'
import cors from 'cors'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import { verifyConnection as verifyNeo4j, closeDriver } from './lib/neo4j.js'
import { chatRouter } from './api/routes/chat.js'
import { voiceRouter } from './api/routes/voice.js'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { startTelegramTransport } from './transport/telegram.js'
import { startScheduler, stopScheduler } from './workers/scheduler.js'

const app = express()

// ─── Middleware ───
app.use(cors())
app.use(express.json())

// ─── Health check ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.2.0' })
})

// ─── Static files (voice call page) ───
app.use(express.static(path.join(__dirname, '..', 'public')))

// ─── Routes ───
app.use('/api/chat', chatRouter)
app.use('/api/voice', voiceRouter)

// ─── Start ───
async function start() {
  // Verify external connections
  const neo4jOk = await verifyNeo4j()
  if (!neo4jOk) {
    logger.warn('Neo4j unavailable — memory retrieval will return empty results')
  }

  // Start Express API server
  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'companion-v2 API server running')
  })

  // Start Telegram polling
  startTelegramTransport()

  // Start cron scheduler for check-ins
  startScheduler()

  logger.info('companion-v2 fully started — API + Telegram + Scheduler')
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down')
  stopScheduler()
  await closeDriver()
  process.exit(0)
})

start().catch((err) => {
  logger.error({ err }, 'Failed to start server')
  process.exit(1)
})
