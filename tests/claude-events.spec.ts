/** Replays recorded Claude SDK message sequences through the event mapper and checks the runtime events, costs and background counts they produce. */
import { describe, expect, it } from 'vitest'
import { EventMapper, outcomeOf, subagentMessage } from '../src/runtimes/claude/events.ts'
import { RECORDED, replay, type Step } from './fixtures/claude-recorded.ts'

const rec = (key: string): Step[] => {
  const steps = RECORDED[key]
  if (!steps) throw new Error(key)
  return steps
}

const turnEnds = (events: ReturnType<typeof replay>) => events.filter(e => e.type === 'turnEnded')

describe('claude event mapping', () => {
  it('turn costs are increments of the cumulative total', () => {
    const ends = turnEnds(replay(rec('streaming-costs')))
    expect(ends).toHaveLength(3)
    const costs = ends.map(e => (e as { costUsd: number }).costUsd)
    expect(costs[0]).toBeCloseTo(0.00101398, 8)
    expect(costs[1]).toBeCloseTo(0.00018722, 8)
    expect(costs[2]).toBeCloseTo(0.00016533, 8)
    expect(ends.map(e => (e as { turns: number }).turns)).toEqual([1, 1, 1])
    expect(ends.every(e => (e as { outcome: string }).outcome === 'success')).toBe(true)
  })

  it('a resumed session starts its cost from zero', () => {
    const ends = turnEnds(replay(rec('resumed-session')))
    expect(ends).toHaveLength(1)
    expect((ends[0] as { costUsd: number }).costUsd).toBeCloseTo(0.00153088, 8)
  })

  it('a cumulative total that drops counts in full', () => {
    const steps: Step[] = [
      {
        kind: 'message',
        message: { type: 'result', subtype: 'success', total_cost_usd: 0.002, num_turns: 1 } as never,
      },
      {
        kind: 'message',
        message: { type: 'result', subtype: 'success', total_cost_usd: 0.0005, num_turns: 1 } as never,
      },
    ]
    const costs = turnEnds(replay(steps)).map(e => (e as { costUsd: number }).costUsd)
    expect(costs).toEqual([0.002, 0.0005])
  })

  it('limit subtypes map to max_turns and budget', () => {
    expect(turnEnds(replay(rec('max-turns')))).toEqual([
      expect.objectContaining({ type: 'turnEnded', outcome: 'max_turns', turns: 2 }),
    ])
    expect(turnEnds(replay(rec('max-budget')))).toEqual([
      expect.objectContaining({ type: 'turnEnded', outcome: 'budget' }),
    ])
    expect(outcomeOf('error_during_execution')).toBe('error')
  })

  it('hooks emit unread ids in FIFO order with carried injects', () => {
    expect(replay(rec('inject-carried'))).toEqual([{ type: 'inputsRead', ids: ['N', 'C'] }])
    const reads = replay(rec('steer-fifo')).filter(e => e.type === 'inputsRead')
    expect(reads).toEqual([
      { type: 'inputsRead', ids: ['A'] },
      { type: 'inputsRead', ids: ['B', 'S'] },
    ])
  })

  it('a result flushes unread ids before turnEnded', () => {
    const events = replay(rec('streaming-costs'))
    const lastEnd = events.findLastIndex(e => e.type === 'turnEnded')
    expect(events[lastEnd - 1]).toEqual({ type: 'inputsRead', ids: ['C'] })
  })

  it.each(['background-late', 'background-early'])(
    'background stays above zero until the follow-up result (%s)',
    name => {
      expect(turnEnds(replay(rec(name))).map(e => (e as { background: number }).background)).toEqual([1, 0])
    },
  )

  it('foreground tasks do not count as background', () => {
    expect(turnEnds(replay(rec('foreground-task'))).map(e => (e as { background: number }).background)).toEqual([0])
  })

  it('api errors become error events and carry cost to the next turn', () => {
    const events = replay(rec('api-error'))
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', retryable: true }))
    const ends = turnEnds(events)
    expect(ends).toHaveLength(1)
    expect((ends[0] as { costUsd: number }).costUsd).toBeCloseTo(0.0009, 8)

    expect(replay(rec('auth-error'))).toContainEqual(expect.objectContaining({ type: 'error', retryable: false }))
  })

  it('an interrupted turn ends with a discarded turnEnded that carries its usage, and the next turn counts from it', () => {
    const ends = turnEnds(replay(rec('interrupted')))
    expect(ends).toHaveLength(2)
    expect(ends[0]).toEqual(
      expect.objectContaining({
        type: 'turnEnded',
        outcome: 'success',
        turns: 3,
        background: 0,
        discarded: true,
        costUsd: expect.closeTo(0.00100205, 8),
      }),
    )
    expect(ends[1]).toEqual(
      expect.objectContaining({
        type: 'turnEnded',
        outcome: 'success',
        turns: 1,
        costUsd: expect.closeTo(0.0015 - 0.00100205, 8),
      }),
    )
    expect((ends[1] as { discarded?: true }).discarded).toBeUndefined()
  })

  it('init with a new session id emits session', () => {
    const mapper = new EventMapper('S')
    expect(mapper.message({ type: 'system', subtype: 'init', session_id: 'S' } as never)).toEqual([])
    expect(mapper.message({ type: 'system', subtype: 'init', session_id: 'S2' } as never)).toEqual([
      { type: 'session', sessionId: 'S2' },
    ])
  })
})

it('subagent messages do not end the turn or set the API error', () => {
  const mapper = new EventMapper('S')
  const events = [
    ...mapper.message({
      type: 'assistant',
      parent_tool_use_id: 'toolu_1',
      agent_id: 'a1',
      error: 'rate_limit',
      message: { id: 'm1', content: [] },
    } as never),
    ...mapper.message({
      type: 'result',
      subtype: 'success',
      agent_id: 'a1',
      total_cost_usd: 0.01,
      num_turns: 1,
    } as never),
    ...mapper.message({ type: 'result', subtype: 'success', total_cost_usd: 0.02, num_turns: 1 } as never),
  ]
  expect(events.filter(e => e.type === 'turnEnded')).toEqual([
    expect.objectContaining({ type: 'turnEnded', outcome: 'success', costUsd: expect.closeTo(0.02, 8) }),
  ])
  expect(events.some(e => e.type === 'error')).toBe(false)
  expect(subagentMessage({ type: 'assistant', parent_tool_use_id: null })).toBe(false)
})

it('a result suppressed by interrupt still reports its usage as discarded', () => {
  const mapper = new EventMapper('S')
  mapper.message({ type: 'result', subtype: 'success', total_cost_usd: 0.2, num_turns: 1 } as never)
  mapper.skipNextResult()
  expect(
    mapper.message({ type: 'result', subtype: 'error_during_execution', total_cost_usd: 0.7, num_turns: 3 } as never),
  ).toEqual([
    expect.objectContaining({
      type: 'turnEnded',
      outcome: 'success',
      turns: 3,
      background: 0,
      discarded: true,
      costUsd: expect.closeTo(0.5, 8),
    }),
  ])
  const next = mapper.message({ type: 'result', subtype: 'success', total_cost_usd: 0.9, num_turns: 1 } as never)
  expect(next).toEqual([
    expect.objectContaining({ type: 'turnEnded', outcome: 'success', turns: 1, costUsd: expect.closeTo(0.2, 8) }),
  ])
})
