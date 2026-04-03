import express from 'express'
import cors from 'cors'
import { env } from './config/env.js'
import { logger } from './lib/logger.js'
import { verifyConnection as verifyNeo4j, closeDriver } from './lib/neo4j.js'
import { chatRouter } from './api/routes/chat.js'

const app = express()

// ─── Middleware ───
app.use(cors())
app.use(express.json())

// ─── Health check ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.1.0' })
})

// ─── Routes ───
app.use('/api/chat', chatRouter)

// TODO Phase 1: profile, goals, metrics, labs routes
// TODO Phase 2: BullMQ worker routes, scheduler

// ─── Start ───
async function start() {
  // Verify external connections
  const neo4jOk = await verifyNeo4j()
  if (!neo4jOk) {
    logger.warn('Neo4j unavailable — memory retrieval will return empty results')
  }

  app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'companion-v2 server running')
  })
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down')
  await closeDriver()
  process.exit(0)
})

start().catch((err) => {
  logger.error({ err }, 'Failed to start server')
  process.exit(1)
})
