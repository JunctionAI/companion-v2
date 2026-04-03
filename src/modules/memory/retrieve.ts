/**
 * Memory Retrieval — Neo4j Cypher queries (zero API cost)
 *
 * Ported from tom-command-center/core/neo4j_memory.py retrieve()
 * 3 parallel queries: category-based, keyword-based, core identity
 */

import { getDriver } from '../../lib/neo4j.js'
import { logger } from '../../lib/logger.js'
import type { UserFact } from '../../types/index.js'

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  biographical: ['who', 'age', 'born', 'name', 'live', 'location', 'city', 'job', 'work'],
  goal: ['goal', 'want', 'aim', 'target', 'plan', 'build', 'achieve', 'vision'],
  constraint: ['can\'t', 'cannot', 'avoid', 'limit', 'allergy', 'pain', 'injury', 'condition', 'medical', 'health'],
  preference: ['like', 'prefer', 'enjoy', 'love', 'hate', 'food', 'eat', 'drink', 'music'],
  pattern: ['usually', 'often', 'always', 'habit', 'routine', 'sleep', 'wake', 'mood', 'energy'],
  decision: ['decided', 'chose', 'committed', 'sober', 'quit', 'stopped', 'started'],
  event: ['happened', 'occurred', 'recently', 'ago', 'when', 'date'],
}

const STOPWORDS = new Set([
  'i', 'me', 'my', 'we', 'you', 'the', 'a', 'an', 'is', 'are', 'was',
  'did', 'do', 'have', 'had', 'been', 'how', 'what', 'when', 'where',
  'just', 'so', 'and', 'but', 'or', 'it', 'that', 'this', 'in', 'on',
  'at', 'to', 'for', 'of', 'with', 'can', 'will', 'not', 'no', 'yes',
])

function inferCategories(message: string): string[] {
  const lower = message.toLowerCase()
  const matched: string[] = []
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) matched.push(category)
  }
  // Always include core categories
  for (const always of ['biographical', 'constraint', 'goal']) {
    if (!matched.includes(always)) matched.push(always)
  }
  return matched
}

function extractKeywords(message: string): string[] {
  const words = message.toLowerCase().match(/\b[a-z]{3,}\b/g) || []
  const seen = new Set<string>()
  const result: string[] = []
  for (const w of words) {
    if (!STOPWORDS.has(w) && !seen.has(w)) {
      seen.add(w)
      result.push(w)
    }
    if (result.length >= 15) break
  }
  return result
}

export async function retrieveUserFacts(message: string, userId: string): Promise<UserFact[]> {
  const driver = getDriver()
  const categories = inferCategories(message)
  const keywords = extractKeywords(message)

  const allRows: UserFact[] = []

  try {
    const session = driver.session()

    // Query 1: Category-based
    const catResult = await session.run(
      `MATCH (u:User {user_id: $uid})-[:HAS_FACT]->(f:Fact)
       WHERE f.category IN $cats
       RETURN f.text AS text, f.category AS category, f.confidence AS confidence, f.updated_at AS updated_at
       ORDER BY f.confidence DESC, f.updated_at DESC
       LIMIT 50`,
      { uid: userId, cats: categories },
    )
    for (const r of catResult.records) {
      allRows.push({
        text: r.get('text'),
        category: r.get('category'),
        confidence: r.get('confidence') ?? 1.0,
        updated_at: r.get('updated_at'),
      })
    }

    // Query 2: Keyword-based
    if (keywords.length > 0) {
      const kwCondition = keywords.slice(0, 10)
        .map(kw => `toLower(f.text) CONTAINS '${kw.replace(/'/g, '')}'`)
        .join(' OR ')

      const kwResult = await session.run(
        `MATCH (u:User {user_id: $uid})-[:HAS_FACT]->(f:Fact)
         WHERE ${kwCondition}
         RETURN f.text AS text, f.category AS category, f.confidence AS confidence, f.updated_at AS updated_at
         ORDER BY f.confidence DESC
         LIMIT 30`,
        { uid: userId },
      )
      for (const r of kwResult.records) {
        allRows.push({
          text: r.get('text'),
          category: r.get('category'),
          confidence: r.get('confidence') ?? 1.0,
          updated_at: r.get('updated_at'),
        })
      }
    }

    // Query 3: Core identity (always loaded)
    const coreResult = await session.run(
      `MATCH (u:User {user_id: $uid})-[:HAS_FACT]->(f:Fact)
       WHERE f.category IN ['constraint', 'goal', 'biographical'] AND f.confidence >= 0.9
       RETURN f.text AS text, f.category AS category, f.confidence AS confidence, f.updated_at AS updated_at
       ORDER BY f.confidence DESC
       LIMIT 20`,
      { uid: userId },
    )
    for (const r of coreResult.records) {
      allRows.push({
        text: r.get('text'),
        category: r.get('category'),
        confidence: r.get('confidence') ?? 1.0,
        updated_at: r.get('updated_at'),
      })
    }

    await session.close()
  } catch (err) {
    logger.warn({ err }, 'Neo4j memory retrieval failed (non-fatal)')
    return []
  }

  // Deduplicate by text
  const seen = new Set<string>()
  const deduped: UserFact[] = []
  for (const row of allRows) {
    const key = row.text.slice(0, 80).toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(row)
    }
  }

  // Sort by confidence desc, return top 50
  deduped.sort((a, b) => b.confidence - a.confidence)
  return deduped.slice(0, 50)
}
