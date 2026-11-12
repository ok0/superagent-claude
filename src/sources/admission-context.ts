// Ported from dsh-superagent-prototype (MIT) src/sources/admission-context.ts
/** Bounded thread message window loaded for admission assessments. */
import type { ContextMessage, TriggerContext } from './kind.ts'

export function threadWindow(messages: ContextMessage[], sourceId: string) {
  const trigger = messages.findIndex(message => message.id === sourceId)
  const selected = messages
    .map((message, index) => ({ message, index }))
    .filter(({ index }) => index < 5 || (trigger >= 0 && Math.abs(index - trigger) <= 5))
  let previous = -1
  const entries = selected.map(({ message, index }) => {
    const omitted_before = index - previous - 1
    previous = index
    return { message, position: index + 1, omitted_before }
  })
  return {
    entries,
    source_found: trigger >= 0,
    loaded_messages: messages.length,
    omitted_after: messages.length - previous - 1,
  }
}
/**
 * Counts describe only the loaded snapshot, never unread history;
 * `status` reports fallback modes such as `chat_neighbours`.
 */
export async function admissionContext(context: TriggerContext, maxPages: number) {
  const messages: ContextMessage[] = []
  const seen = new Set<string>()
  const cursors = new Set<string>()
  let next: string | undefined
  let status: string | undefined
  let more = true
  for (let page = 0; more && page < maxPages; page++) {
    const result = await context.read('thread', next)
    for (const message of result.messages)
      if (!seen.has(message.id)) {
        seen.add(message.id)
        messages.push(message)
      }
    status ??= result.status
    next = result.next
    more = next !== undefined
    if (next !== undefined && cursors.has(next))
      throw new Error('Thread pagination repeated a cursor; context is incomplete')
    if (next !== undefined) cursors.add(next)
  }
  return {
    messages,
    window: threadWindow(messages, context.messageId),
    complete: !more,
    next: more ? (next ?? null) : null,
    ...(status ? { status } : {}),
  }
}
