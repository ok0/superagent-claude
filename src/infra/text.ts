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
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
