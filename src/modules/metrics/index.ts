/**
 * Health Metrics — Manual data input via /log commands
 *
 * Supports:
 *   /log sleep 7.5
 *   /log hrv 45
 *   /log weight 82
 *   /log mood 7
 *   /log energy 6
 *   /log steps 8500
 *   /data — shows recent metrics
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
    initTables(db)
  }
  return db
}

function initTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_lookup
      ON daily_metrics(user_id, metric_name, date DESC);

    CREATE TABLE IF NOT EXISTS biomarker_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      test_name TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL,
      reference_low REAL,
      reference_high REAL,
      flag TEXT NOT NULL DEFAULT 'normal',
      test_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_biomarkers_lookup
      ON biomarker_results(user_id, test_name, test_date DESC);
  `)
}

function nowNZ(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: env.TIMEZONE }).replace(' ', 'T')
}

function todayNZ(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })
}

// ─── Metric Types ───

const METRIC_UNITS: Record<string, string> = {
  sleep: 'hours',
  hrv: 'ms',
  weight: 'kg',
  mood: '/10',
  energy: '/10',
  focus: '/10',
  steps: 'steps',
  water: 'L',
  protein: 'g',
  calories: 'kcal',
}

export function isValidMetric(name: string): boolean {
  return name in METRIC_UNITS
}

export function getMetricNames(): string[] {
  return Object.keys(METRIC_UNITS)
}

// ─── Daily Metrics ───

export function logMetric(userId: string, metricName: string, value: number): string {
  const unit = METRIC_UNITS[metricName] || ''
  getDb().prepare(
    `INSERT INTO daily_metrics (user_id, metric_name, value, unit, date, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(userId, metricName, value, unit, todayNZ(), nowNZ())

  logger.info({ userId, metric: metricName, value }, 'Metric logged')
  return `Logged: ${metricName} = ${value}${unit}`
}

export function getRecentMetrics(userId: string, days = 7): string {
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })

  const rows = getDb().prepare(
    `SELECT metric_name, value, unit, date FROM daily_metrics
     WHERE user_id = ? AND date > ?
     ORDER BY date DESC, metric_name ASC`,
  ).all(userId, cutoff) as Array<{ metric_name: string; value: number; unit: string; date: string }>

  if (rows.length === 0) return 'No metrics logged in the last 7 days.\n\nLog data with: /log <metric> <value>\nMetrics: ' + getMetricNames().join(', ')

  // Group by date
  const byDate: Record<string, Array<{ metric_name: string; value: number; unit: string }>> = {}
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = []
    byDate[r.date].push(r)
  }

  let output = 'Recent metrics (last 7 days):\n'
  for (const [date, metrics] of Object.entries(byDate)) {
    output += `\n${date}:\n`
    for (const m of metrics) {
      output += `  ${m.metric_name}: ${m.value}${m.unit}\n`
    }
  }

  return output
}

/**
 * Load recent metrics as context for agent brain injection.
 */
export function loadMetricsContext(userId: string, days = 14): string {
  const cutoff = new Date(Date.now() - days * 86400_000)
    .toLocaleDateString('sv-SE', { timeZone: env.TIMEZONE })

  const rows = getDb().prepare(
    `SELECT metric_name, value, unit, date FROM daily_metrics
     WHERE user_id = ? AND date > ?
     ORDER BY date DESC, metric_name ASC`,
  ).all(userId, cutoff) as Array<{ metric_name: string; value: number; unit: string; date: string }>

  if (rows.length === 0) return ''

  let context = '=== TRACKED HEALTH METRICS (last 14 days) ===\n'
  const byDate: Record<string, string[]> = {}
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = []
    byDate[r.date].push(`${r.metric_name}: ${r.value}${r.unit}`)
  }
  for (const [date, items] of Object.entries(byDate)) {
    context += `${date}: ${items.join(', ')}\n`
  }

  return context
}

// ─── Biomarker Results ───

export interface BiomarkerRow {
  test_name: string
  value: number
  unit: string
  reference_low: number | null
  reference_high: number | null
  flag: string
  test_date: string
}

export function saveBiomarkerResult(
  userId: string,
  testName: string,
  value: number,
  unit: string,
  refLow: number | null,
  refHigh: number | null,
  flag: string,
  testDate?: string,
) {
  getDb().prepare(
    `INSERT INTO biomarker_results (user_id, test_name, value, unit, reference_low, reference_high, flag, test_date, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, testName, value, unit, refLow, refHigh, flag, testDate ?? todayNZ(), nowNZ())
}

export function getLatestBiomarkers(userId: string): BiomarkerRow[] {
  // Get the most recent test date
  const latest = getDb().prepare(
    'SELECT MAX(test_date) as latest_date FROM biomarker_results WHERE user_id = ?',
  ).get(userId) as { latest_date: string | null }

  if (!latest.latest_date) return []

  return getDb().prepare(
    `SELECT test_name, value, unit, reference_low, reference_high, flag, test_date
     FROM biomarker_results WHERE user_id = ? AND test_date = ?
     ORDER BY test_name ASC`,
  ).all(userId, latest.latest_date) as BiomarkerRow[]
}

/**
 * Load biomarker context for agent brain injection.
 */
export function loadBiomarkerContext(userId: string): string {
  const results = getLatestBiomarkers(userId)
  if (results.length === 0) return ''

  let context = `=== BLOOD TEST RESULTS (${results[0].test_date}) ===\n`
  const flagged = results.filter(r => r.flag !== 'normal')
  const normal = results.filter(r => r.flag === 'normal')

  if (flagged.length > 0) {
    context += '\nFlagged:\n'
    for (const r of flagged) {
      const range = r.reference_low !== null && r.reference_high !== null
        ? ` (ref: ${r.reference_low}-${r.reference_high})`
        : ''
      context += `- ${r.test_name}: ${r.value} ${r.unit}${range} [${r.flag.toUpperCase()}]\n`
    }
  }
  if (normal.length > 0) {
    context += `\nNormal (${normal.length}): ${normal.map(r => `${r.test_name}: ${r.value} ${r.unit}`).join(', ')}\n`
  }

  return context
}
