// Ported from dsh-superagent-prototype (MIT) tests/admission-context.spec.ts
/** Admission context window and paging cases. */
import { expect, it, vi } from 'vitest'
import { admissionContext, threadWindow } from '../src/sources/admission-context.ts'
import type { ContextMessage, TriggerContext } from '../src/sources/kind.ts'

const message = (i: number): ContextMessage => ({ id: `m_${i}`, from: 'u_user', at: String(i), text: `Message ${i}` })

it('returns the thread opening and trigger neighbors with exact internal and trailing gaps', () => {
  const result = threadWindow(
    Array.from({ length: 40 }, (_, i) => message(i)),
    'm_25',
  )
  expect(result.entries.map((item: { position: number }) => item.position)).toEqual([
    1, 2, 3, 4, 5, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
  ])
  expect(result.entries[5]?.omitted_before).toBe(15)
  expect(result.omitted_after).toBe(9)
  expect(result.source_found).toBe(true)
})
it('deduplicates overlapping windows and reports an absent source without inventing neighbors', () => {
  const messages = Array.from({ length: 12 }, (_, i) => message(i))
  expect(threadWindow(messages, 'm_3').entries.map((item: { position: number }) => item.position)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ])
  expect(threadWindow(messages, 'm_absent')).toMatchObject({
    source_found: false,
    loaded_messages: 12,
    omitted_after: 7,
  })
})
it('retains pagination limits and exact loaded counts rather than claiming complete history', async () => {
  const read = vi.fn().mockResolvedValueOnce({ messages: [message(0), message(1)], next: 'next', body: {} })
  const context: TriggerContext = { messageId: 'm_9', read }
  expect(await admissionContext(context, 1)).toMatchObject({
    complete: false,
    next: 'next',
    window: { loaded_messages: 2, source_found: false },
  })
  expect(read).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledWith('thread', undefined)
})
it('reads pages until none is left and refuses a repeated cursor', async () => {
  const pages = vi
    .fn()
    .mockResolvedValueOnce({ messages: [message(0)], next: 'a', status: 'paged', body: {} })
    .mockResolvedValueOnce({ messages: [message(0), message(1)], body: {} })
  const result = await admissionContext({ messageId: 'm_1', read: pages }, 3)
  expect(result).toMatchObject({ complete: true, next: null, status: 'paged' })
  expect(result.messages.map(item => item.id)).toEqual(['m_0', 'm_1'])
  const repeated = vi.fn().mockResolvedValue({ messages: [message(0)], next: 'a', body: {} })
  await expect(admissionContext({ messageId: 'm_0', read: repeated }, 3)).rejects.toThrow('repeated a cursor')
})
