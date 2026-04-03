import neo4j, { type Driver } from 'neo4j-driver'
import { env } from '../config/env.js'
import { logger } from './logger.js'

let driver: Driver | null = null

export function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(
      env.NEO4J_URI,
      neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD),
    )
    logger.info('Neo4j driver initialised')
  }
  return driver
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close()
    driver = null
    logger.info('Neo4j driver closed')
  }
}

export async function verifyConnection(): Promise<boolean> {
  try {
    const d = getDriver()
    await d.verifyConnectivity()
    logger.info('Neo4j connection verified')
    return true
  } catch (err) {
    logger.error({ err }, 'Neo4j connection failed')
    return false
  }
}
