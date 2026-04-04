import Redis from 'ioredis'
import { env } from '../config/env.js'
import { logger } from './logger.js'

let redis: InstanceType<typeof Redis.default> | null = null

if (env.REDIS_URL) {
  redis = new Redis.default(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  })
  redis.on('connect', () => logger.info('Redis connected'))
  redis.on('error', (err: Error) => logger.error({ err }, 'Redis error'))
} else {
  logger.info('Redis not configured — BullMQ will be unavailable')
}

export { redis }
