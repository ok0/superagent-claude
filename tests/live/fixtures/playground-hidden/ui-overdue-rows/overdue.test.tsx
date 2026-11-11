import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import base from './base-dom.json'
import { serialize } from './serialize.tsx'

describe.each(['2001-06-01T00:30:00Z', '2026-11-11T12:00:00Z', '2099-12-31T23:30:00Z'])('with the clock at %s', now => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(now))
  })

  afterEach(() => vi.useRealTimers())

  it('the overdue row differs from the base', async () => {
    const dom = await serialize()
    expect(dom.rows.overdue).not.toBeNull()
    expect(dom.rows.overdue).not.toBe(base.rows.overdue)
  })

  it('rows that are not overdue match the base', async () => {
    const dom = await serialize()
    expect({ future: dom.rows.future, none: dom.rows.none, doneFuture: dom.rows.doneFuture }).toEqual({
      future: base.rows.future,
      none: base.rows.none,
      doneFuture: base.rows.doneFuture,
    })
  })

  it('other components match the base', async () => {
    const dom = await serialize()
    expect(dom.components).toEqual(base.components)
  })
})
