/**
 * SQLite Memory System — Permanent fact store + message archive
 *
 * Ported from tom-command-center/core/user_memory.py
 * Uses better-sqlite3 (sync, fast, no async overhead).
 *
 * Tables: user_facts, messages, session_summaries, extraction_log
 */

import Database from 'better-sqlite3'
import { resolve } from 'path'
import { logger } from '../../lib/logger.js'
import { env } from '../../config/env.js'

const DB_PATH = resolve(import.meta.dirname, '../../../data/user_memory.db')

let db: Database.Database | null = null

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    initSchema(db)
    logger.info({ path: DB_PATH }, 'SQLite memory DB opened')
  }
  return db
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      confidence REAL NOT NULL DEFAULT 1.0,
      source_summary TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      superseded_by INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_facts_user_agent
      ON user_facts(user_id, agent_id, is_active);
    CREATE INDEX IF NOT EXISTS idx_facts_category
      ON user_facts(user_id, agent_id, category, is_active);

    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_summaries_unique
      ON session_summaries(user_id, agent_id, date);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_lookup
      ON messages(user_id, agent_id, chat_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS extraction_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      facts_added INTEGER NOT NULL DEFAULT 0,
      facts_updated INTEGER NOT NULL DEFAULT 0,
      facts_skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `)
}

function nowNZ(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: env.TIMEZONE }).replace(' ', 'T')
}

function todayNZ(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })
}

// ─── Messages ───

export function saveMessage(
  userId: string, agentId: string, chatId: string, role: string, content: string,
) {
  getDb().prepare(
    'INSERT INTO messages (user_id, agent_id, chat_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(userId, agentId, chatId, role, content, nowNZ())
}

export function getRecentMessages(
  userId: string, agentId: string, chatId: string, maxMessages = 20, maxAgeHours = 72,
): Array<{ role: string; content: string }> {
  const cutoff = new Date(Date.now() - maxAgeHours * 3600_000)
    .toLocaleString('sv-SE', { timeZone: env.TIMEZONE }).replace(' ', 'T')

  const rows = getDb().prepare(
    `SELECT role, content FROM messages
     WHERE user_id = ? AND agent_id = ? AND chat_id = ? AND created_at > ?
     ORDER BY created_at DESC LIMIT ?`,
  ).all(userId, agentId, chatId, cutoff, maxMessages) as Array<{ role: string; content: string }>

  const reversed = rows.reverse()
  // Ensure first message is user (Claude API requirement)
  const firstUserIdx = reversed.findIndex(m => m.role === 'user')
  return firstUserIdx > 0 ? reversed.slice(firstUserIdx) : reversed
}

export function getMessageCount(userId: string, agentId: string): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND agent_id = ?',
  ).get(userId, agentId) as { count: number }
  return row.count
}

// ─── Facts ───

export interface StoredFact {
  id: number
  fact: string
  category: string
  confidence: number
  updated_at: string
  agent_id: string
}

export function getUserFacts(
  userId: string, agentId: string, category?: string, includeGlobal = true,
): StoredFact[] {
  let sql = 'SELECT id, fact, category, confidence, updated_at, agent_id FROM user_facts WHERE user_id = ? AND is_active = 1'
  const params: unknown[] = [userId]

  if (!includeGlobal) {
    sql += ' AND agent_id = ?'
    params.push(agentId)
  }
  if (category) {
    sql += ' AND category = ?'
    params.push(category)
  }

  sql += ' ORDER BY confidence DESC, updated_at DESC'
  return getDb().prepare(sql).all(...params) as StoredFact[]
}

export function addFact(
  userId: string, agentId: string, fact: string, category = 'general',
  confidence = 1.0, sourceSummary?: string,
): number {
  const now = nowNZ()
  const result = getDb().prepare(
    `INSERT INTO user_facts (user_id, agent_id, fact, category, confidence, source_summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, agentId, fact, category, confidence, sourceSummary ?? null, now, now)
  return Number(result.lastInsertRowid)
}

export function updateFact(factId: number, newFact: string, newConfidence?: number) {
  if (newConfidence !== undefined) {
    getDb().prepare(
      'UPDATE user_facts SET fact = ?, confidence = ?, updated_at = ? WHERE id = ?',
    ).run(newFact, newConfidence, nowNZ(), factId)
  } else {
    getDb().prepare(
      'UPDATE user_facts SET fact = ?, updated_at = ? WHERE id = ?',
    ).run(newFact, nowNZ(), factId)
  }
}

export function deactivateFact(factId: number, supersededBy?: number) {
  getDb().prepare(
    'UPDATE user_facts SET is_active = 0, superseded_by = ?, updated_at = ? WHERE id = ?',
  ).run(supersededBy ?? null, nowNZ(), factId)
}

export function deleteFactsByText(userId: string, searchText: string): number {
  const result = getDb().prepare(
    'UPDATE user_facts SET is_active = 0, updated_at = ? WHERE user_id = ? AND is_active = 1 AND fact LIKE ?',
  ).run(nowNZ(), userId, `%${searchText}%`)
  return result.changes
}

export function deleteAllFacts(userId: string): number {
  const result = getDb().prepare(
    'UPDATE user_facts SET is_active = 0, updated_at = ? WHERE user_id = ? AND is_active = 1',
  ).run(nowNZ(), userId)
  return result.changes
}

// ─── Session Summaries ───

export function saveSessionSummary(
  userId: string, agentId: string, summary: string, messageCount: number, dateStr?: string,
) {
  const date = dateStr ?? todayNZ()
  getDb().prepare(
    `INSERT OR REPLACE INTO session_summaries (user_id, agent_id, summary, message_count, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, agentId, summary, messageCount, date, nowNZ())
}

export function getRecentSummaries(
  userId: string, agentId: string, days = 30,
): Array<{ summary: string; message_count: number; date: string }> {
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })

  return getDb().prepare(
    `SELECT summary, message_count, date FROM session_summaries
     WHERE user_id = ? AND agent_id = ? AND date > ?
     ORDER BY date DESC`,
  ).all(userId, agentId, cutoff) as Array<{ summary: string; message_count: number; date: string }>
}

// ─── Extraction Log ───

export function logExtraction(
  userId: string, agentId: string, added: number, updated: number, skipped: number,
) {
  getDb().prepare(
    `INSERT INTO extraction_log (user_id, agent_id, facts_added, facts_updated, facts_skipped, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, agentId, added, updated, skipped, nowNZ())
}

// ─── Memory Loading (for agent prompts) ───

export function loadUserMemory(userId: string, agentId: string): string {
  const facts = getUserFacts(userId, agentId, undefined, true)
  if (facts.length === 0) return ''

  // Group by category
  const grouped: Record<string, string[]> = {}
  for (const f of facts) {
    if (!grouped[f.category]) grouped[f.category] = []
    grouped[f.category].push(f.fact)
  }

  let memory = '=== WHAT YOU KNOW ABOUT THIS USER ===\n'
  for (const [cat, items] of Object.entries(grouped)) {
    memory += `\n*${cat.toUpperCase()}:*\n`
    for (const item of items) {
      memory += `- ${item}\n`
    }
  }

  // Session summaries (last 14, capped at 30 days)
  const summaries = getRecentSummaries(userId, agentId, 30).slice(0, 14)
  if (summaries.length > 0) {
    memory += '\n=== RECENT CONVERSATION HISTORY (Summaries) ===\n'
    for (const s of summaries) {
      memory += `[${s.date}] (${s.message_count} messages) ${s.summary}\n`
    }
  }

  // Token budget guard: ~15K chars max
  if (memory.length > 15000) {
    // Rebuild with fewer summaries
    const shortSummaries = summaries.slice(0, 7)
    let trimmed = '=== WHAT YOU KNOW ABOUT THIS USER ===\n'
    for (const [cat, items] of Object.entries(grouped)) {
      trimmed += `\n*${cat.toUpperCase()}:*\n`
      for (const item of items) {
        trimmed += `- ${item}\n`
      }
    }
    if (shortSummaries.length > 0) {
      trimmed += '\n=== RECENT CONVERSATION HISTORY (Summaries) ===\n'
      for (const s of shortSummaries) {
        trimmed += `[${s.date}] (${s.message_count} messages) ${s.summary}\n`
      }
    }
    return trimmed
  }

  return memory
}

export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}
