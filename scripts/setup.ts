#!/usr/bin/env npx tsx
/**
 * Interactive Setup Wizard
 *
 * Run: npm run setup
 *
 * Generates:
 * - .env with required config
 * - config/agents.json with first agent
 * - agents/<name>/ from template
 * - data/ directory for SQLite
 */

import * as readline from 'readline'
import { writeFileSync, readFileSync, existsSync, mkdirSync, cpSync } from 'fs'
import { join, resolve } from 'path'

const ROOT = resolve(import.meta.dirname, '..')
const TEMPLATE_DIR = join(ROOT, 'agents', '_template')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` (${defaultVal})` : ''
  return new Promise(resolve => {
    rl.question(`${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '')
    })
  })
}

function choose(question: string, options: string[]): Promise<string> {
  console.log(`\n${question}`)
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`))
  return new Promise(resolve => {
    rl.question(`Choose [1-${options.length}]: `, answer => {
      const idx = parseInt(answer.trim(), 10) - 1
      resolve(options[idx] || options[0])
    })
  })
}

async function main() {
  console.log(`
╔══════════════════════════════════════════╗
║   companion — AI Health Coach Setup      ║
║   Takes about 2 minutes.                 ║
╚══════════════════════════════════════════╝
`)

  // Check if already configured
  if (existsSync(join(ROOT, '.env')) && existsSync(join(ROOT, 'config', 'agents.json'))) {
    const overwrite = await ask('Existing config found. Overwrite? (y/n)', 'n')
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\nKeeping existing config. Run `npm run dev` to start.')
      rl.close()
      return
    }
  }

  // ─── Step 1: API Keys ───
  console.log('\n── Step 1: API Keys ──\n')

  const anthropicKey = await ask('Anthropic API key (starts with sk-ant-)')
  if (!anthropicKey.startsWith('sk-ant-')) {
    console.log('⚠ That doesn\'t look like an Anthropic API key. Get one at https://console.anthropic.com/')
    const proceed = await ask('Continue anyway? (y/n)', 'n')
    if (proceed.toLowerCase() !== 'y') {
      rl.close()
      return
    }
  }

  // ─── Step 2: Telegram ───
  console.log('\n── Step 2: Telegram Bot ──\n')
  console.log('You need a Telegram bot. Create one:')
  console.log('  1. Open Telegram, search @BotFather')
  console.log('  2. Send /newbot, follow prompts')
  console.log('  3. Copy the bot token\n')

  const botToken = await ask('Telegram bot token')

  console.log('\nNow get your Telegram user ID:')
  console.log('  1. Search @userinfobot in Telegram')
  console.log('  2. Send /start — it replies with your ID\n')

  const ownerId = await ask('Your Telegram user ID (numbers only)')

  // ─── Step 3: About You ───
  console.log('\n── Step 3: About You ──\n')

  const userName = await ask('Your first name')
  const age = await ask('Your age')
  const timezone = await ask('Your timezone', 'UTC')

  const focus = await choose('What\'s your health focus?', [
    'General health & wellness',
    'Fitness & body composition',
    'Nutrition & diet',
    'Recovery & brain health',
    'Mental health & stress',
  ])

  const goals = await ask('Top health goals (comma separated)')
  const medical = await ask('Any medical conditions, allergies, medications? (or "none")', 'none')
  const activity = await choose('Activity level?', [
    'Sedentary (desk job, little exercise)',
    'Lightly active (1-2 sessions/week)',
    'Moderately active (3-4 sessions/week)',
    'Very active (5+ sessions/week)',
    'Athlete (daily training)',
  ])

  // ─── Step 4: Agent Name ───
  console.log('\n── Step 4: Your Companion ──\n')

  const agentDisplayName = await ask('Name your companion', 'Coach')
  const agentName = agentDisplayName.toLowerCase().replace(/[^a-z0-9]/g, '-')
  const userId = userName.toLowerCase().replace(/[^a-z0-9]/g, '-')

  console.log('\nYou\'ll need to create a Telegram group for your companion:')
  console.log(`  1. Create a new Telegram group (name it "${agentDisplayName}")`)
  console.log('  2. Add your bot to the group')
  console.log('  3. Send a message in the group')
  console.log('  4. Visit: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates')
  console.log('     (replace <YOUR_TOKEN> with your bot token)')
  console.log('  5. Find the "chat" object with a negative "id" — that\'s your chat ID\n')

  const chatId = await ask('Group chat ID (negative number, e.g. -5012345678)')

  // ─── Generate Files ───
  console.log('\n── Generating config... ──\n')

  // 1. Generate .env
  const envContent = `PORT=3001
NODE_ENV=development
TIMEZONE=${timezone}

# Anthropic (required)
ANTHROPIC_API_KEY=${anthropicKey}

# Telegram (required)
TELEGRAM_BOT_TOKEN=${botToken}
TELEGRAM_OWNER_ID=${ownerId}

# Supabase (optional — only needed for web API)
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_SERVICE_KEY=your-service-key
# SUPABASE_ANON_KEY=your-anon-key

# Neo4j (optional — adds graph memory on top of SQLite)
# NEO4J_URI=bolt://localhost:7687
# NEO4J_PASSWORD=your-password

# OpenAI (optional — Whisper for voice transcription)
# OPENAI_API_KEY=your-key
`
  writeFileSync(join(ROOT, '.env'), envContent, 'utf-8')
  console.log('  .env created')

  // 2. Generate config/agents.json
  mkdirSync(join(ROOT, 'config'), { recursive: true })

  const agentsConfig = {
    agents: [
      {
        name: agentName,
        chatId,
        userId,
        displayName: agentDisplayName,
        model: 'sonnet' as const,
      },
    ],
    authorizedUsers: [ownerId],
    schedules: [
      { agent: agentName, task: 'morning_checkin', cron: '0 8 * * *' },
      { agent: agentName, task: 'evening_checkin', cron: '0 19 * * *' },
    ],
  }

  writeFileSync(
    join(ROOT, 'config', 'agents.json'),
    JSON.stringify(agentsConfig, null, 2) + '\n',
    'utf-8',
  )
  console.log('  config/agents.json created')

  // 3. Create agent from template
  const agentDir = join(ROOT, 'agents', agentName)
  if (!existsSync(agentDir)) {
    cpSync(TEMPLATE_DIR, agentDir, { recursive: true })

    // Replace placeholders in all .md files
    const replacements: Record<string, string> = {
      '{{DISPLAY_NAME}}': agentDisplayName,
      '{{USER_NAME}}': userName,
      '{{AGE}}': age,
      '{{TIMEZONE}}': timezone,
      '{{GOALS}}': goals.split(',').map(g => `- ${g.trim()}`).join('\n'),
      '{{MEDICAL_CONTEXT}}': medical === 'none' ? 'No known conditions.' : medical,
      '{{ACTIVITY_LEVEL}}': activity,
      '{{DATE}}': new Date().toISOString().split('T')[0],
    }

    replaceInDir(agentDir, replacements)
    console.log(`  agents/${agentName}/ created from template`)
  } else {
    console.log(`  agents/${agentName}/ already exists — skipping`)
  }

  // 4. Ensure data directory exists
  mkdirSync(join(ROOT, 'data'), { recursive: true })
  console.log('  data/ directory ready')

  // Done
  console.log(`
╔══════════════════════════════════════════╗
║   Setup complete!                        ║
║                                          ║
║   Start your companion:                  ║
║     npm run dev                          ║
║                                          ║
║   Then message your Telegram group.      ║
╚══════════════════════════════════════════╝
`)

  rl.close()
}

function replaceInDir(dir: string, replacements: Record<string, string>) {
  const { readdirSync, statSync } = require('fs') as typeof import('fs')
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      replaceInDir(fullPath, replacements)
    } else if (entry.endsWith('.md')) {
      let content = readFileSync(fullPath, 'utf-8')
      for (const [placeholder, value] of Object.entries(replacements)) {
        content = content.replaceAll(placeholder, value)
      }
      writeFileSync(fullPath, content, 'utf-8')
    }
  }
}

main().catch(err => {
  console.error('Setup failed:', err)
  process.exit(1)
})
