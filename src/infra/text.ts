// Ported from dsh-superagent-prototype (MIT) src/infra/text.ts
/**
 * Word counting and string formatting utilities for message limits and templates.
 * Changes from the reference: `IM_WORDS`, `checkedImText` and `sameName` are removed; `policy/actors.ts` is the single `sameName`.
 */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
export const fill = (template: string, values: Record<string, string>): string =>
  template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Lines that credit the AI product as an author (ADR-34): a Co-authored-by trailer whose name has the word Claude or whose address is @anthropic.com, and a "Generated with … Claude" line. Case-insensitive, one line at a time. scripts/check-commits.ts uses the same predicate. */
export const AI_ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /^\s*co-authored-by:[^<\r\n]*\bclaude\b/i,
  /^\s*co-authored-by:.*@anthropic\.com\b/i,
  /\bgenerated with\b.*\bclaude\b/i,
]
export const isAiAttributionLine = (line: string): boolean =>
  AI_ATTRIBUTION_PATTERNS.some(pattern => pattern.test(line))
/** Removes AI attribution lines; returns `text` itself when there are none. Blank lines that the removal leaves doubled (or leading) are dropped, trailing blank lines are trimmed, and one final newline is kept when `text` had one. All other lines stay as they were. */
export function stripAiAttribution(text: string): string {
  const lines = text.split('\n')
  if (!lines.some(isAiAttributionLine)) return text
  const out: string[] = []
  let removed = false
  for (const line of lines) {
    if (isAiAttributionLine(line)) {
      removed = true
      continue
    }
    const blank = line.trim() === ''
    if (blank && removed && (out.length === 0 || out[out.length - 1]!.trim() === '')) continue
    out.push(line)
    if (!blank) removed = false
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop()
  const body = out.join('\n')
  return body !== '' && text.endsWith('\n') ? body + '\n' : body
}
