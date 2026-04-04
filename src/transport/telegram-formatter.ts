/**
 * Telegram Response Formatter
 *
 * Sanitizes agent responses for Telegram's limited Markdown support.
 * Converts tables to line-by-line format (Tom's preference).
 */

/** Convert markdown tables to line-by-line format */
function convertTables(text: string): string {
  // Match markdown tables (header row + separator + data rows)
  const tableRegex = /(\|[^\n]+\|\n)(\|[-:| ]+\|\n)((?:\|[^\n]+\|\n?)+)/g

  return text.replace(tableRegex, (_match, headerRow: string, _sep: string, bodyRows: string) => {
    const headers = headerRow.split('|').map((h: string) => h.trim()).filter(Boolean)
    const rows = bodyRows.trim().split('\n').map((row: string) =>
      row.split('|').map((c: string) => c.trim()).filter(Boolean),
    )

    let result = ''
    for (const row of rows) {
      for (let i = 0; i < row.length && i < headers.length; i++) {
        if (row[i] && row[i] !== '-') {
          result += `${headers[i]}: ${row[i]}\n`
        }
      }
      result += '\n'
    }
    return result
  })
}

/** Sanitize markdown for Telegram (v1 limited support) */
function sanitizeMarkdown(text: string): string {
  // Convert ### headers to bold (Telegram doesn't support headers)
  let result = text.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Ensure bold markers are balanced
  const boldCount = (result.match(/\*\*/g) || []).length
  if (boldCount % 2 !== 0) {
    result = result.replace(/\*\*/g, '*')
  }

  return result
}

/** Full formatting pipeline for Telegram delivery */
export function formatForTelegram(text: string): string {
  let result = text

  // Convert tables to line-by-line
  result = convertTables(result)

  // Sanitize markdown
  result = sanitizeMarkdown(result)

  // Remove excessive whitespace
  result = result.replace(/\n{3,}/g, '\n\n').trim()

  return result
}
