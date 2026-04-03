/**
 * Medical Context Resolver
 *
 * Scans inbound messages for health nouns. If found, runs a lightweight
 * Cypher query against the Neo4j Medical Knowledge Graph to pull
 * interactions, contraindications, and relevant clinical context.
 *
 * Phase 3 deliverable — stub for now.
 */

import { getDriver } from '../../lib/neo4j.js'
import { logger } from '../../lib/logger.js'

export async function resolveMedicalContext(
  _messageText: string,
  _userId: string,
): Promise<string | undefined> {
  // TODO Phase 3: keyword detection → Cypher query against medical graph
  // For now, returns undefined (no medical context injected)
  logger.debug('Medical context resolver: stub (Phase 3)')
  return undefined
}
