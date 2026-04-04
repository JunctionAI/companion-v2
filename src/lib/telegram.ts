/**
 * Telegram Bot Client
 *
 * Thin wrapper around node-telegram-bot-api for sending messages.
 * Handles markdown fallback, message splitting, and typing indicators.
 */

import TelegramBot from 'node-telegram-bot-api'
import { env } from '../config/env.js'
import { logger } from './logger.js'

let bot: TelegramBot | null = null

export function getBot(): TelegramBot {
  if (!bot) {
    bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: false })
  }
  return bot
}

export function startPollingBot(): TelegramBot {
  if (!bot) {
    bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, {
      polling: {
        interval: 1000,
        params: { timeout: 30 },
      },
    })
    logger.info('Telegram bot polling started')
  }
  return bot
}

/** Send typing indicator (non-fatal) */
export async function sendTyping(chatId: string): Promise<void> {
  try {
    await getBot().sendChatAction(chatId, 'typing')
  } catch {
    // Non-fatal
  }
}

/**
 * Send a message to Telegram, splitting on paragraph boundaries if needed.
 * Tries Markdown first, falls back to plain text on parse errors.
 */
export async function sendMessage(chatId: string, text: string): Promise<boolean> {
  const chunks = splitMessage(text, 4000)

  for (const chunk of chunks) {
    try {
      await getBot().sendMessage(chatId, chunk, { parse_mode: 'Markdown' })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes("can't parse") || errMsg.includes('Bad Request')) {
        // Markdown failed — retry as plain text
        try {
          await getBot().sendMessage(chatId, chunk)
        } catch (err2) {
          logger.error({ err: err2, chatId }, 'Telegram send failed (plain text)')
          return false
        }
      } else {
        logger.error({ err, chatId }, 'Telegram send failed')
        return false
      }
    }
  }
  return true
}

/**
 * Download a file from Telegram and return as base64.
 * Used for blood test photos/documents.
 */
export async function downloadFileAsBase64(fileId: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const file = await getBot().getFile(fileId)
    if (!file.file_path) return null

    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`
    const response = await fetch(url)
    if (!response.ok) return null

    const buffer = Buffer.from(await response.arrayBuffer())
    const ext = file.file_path.split('.').pop()?.toLowerCase() || ''
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
    }

    return {
      base64: buffer.toString('base64'),
      mimeType: mimeMap[ext] || 'application/octet-stream',
    }
  } catch (err) {
    logger.error({ err, fileId }, 'Failed to download Telegram file')
    return null
  }
}

/** Split text on paragraph boundaries to fit Telegram's 4096 char limit */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }

    // Find last paragraph break within limit
    let splitAt = remaining.lastIndexOf('\n\n', maxLen)
    if (splitAt < maxLen * 0.3) {
      // No good paragraph break — try single newline
      splitAt = remaining.lastIndexOf('\n', maxLen)
    }
    if (splitAt < maxLen * 0.3) {
      // No newline either — hard cut at space
      splitAt = remaining.lastIndexOf(' ', maxLen)
    }
    if (splitAt < 1) splitAt = maxLen

    chunks.push(remaining.slice(0, splitAt).trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
  }

  return chunks
}
