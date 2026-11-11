/** Runs the runtime-neutral contract suite against the scripted FakeRuntime, and checks that the fake's delays go through the injected timers. */
import { describe, expect, it } from 'vitest'
import { FakeRuntime, type FakeScript } from '../src/runtimes/fake/runtime.ts'
import { waitUntil } from './fixtures/async.ts'
import { type ContractCase, contractSpec, runtimeContract } from './fixtures/runtime-contract.ts'

const SCRIPTS: Record<ContractCase, FakeScript> = {
  'steer joins the running turn': () => ({ tools: [{ name: 'wait', args: {} }] }),
  'steer in a running turn is reported read before the turn ends': () => ({ tools: [{ name: 'wait', args: {} }] }),
  'followup starts a new turn': () => ({}),
  'inject does not wake the session': () => ({}),
  'a tool call reaches the host': ({ index }) =>
    index === 0 ? { tools: [{ name: 'report', args: { state: 'ready', summary: 'done' } }] } : {},
  'a turn over the limit ends with a limit outcome': () => ({ turnEnded: { outcome: 'max_turns', turns: 2 } }),
  'interrupt returns the pending inputs': ({ index }) => (index === 0 ? { hold: new Promise(() => {}) } : {}),
  'the host reads each input once': () => ({ repeatReads: true }),
  'resume keeps the session id': () => ({}),
}

runtimeContract('fake', name => new FakeRuntime(SCRIPTS[name]))

describe('fake runtime', () => {
  it('uses the injected timers for delays', async () => {
    const pending: (() => void)[] = []
    const runtime = new FakeRuntime(() => ({ delayMs: 1000 }), {
      timers: {
        setTimeout: run => {
          pending.push(run)
        },
      },
    })
    const { spec } = contractSpec('followup starts a new turn')
    const session = await runtime.open(spec)
    session.send({ id: 'A', text: 'A', mode: 'followup' })
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve))
    expect(session.log.some(event => event.type === 'turnEnded')).toBe(false)
    expect(pending).toHaveLength(1)
    for (const run of pending.splice(0)) run()
    await waitUntil(() => session.log.some(event => event.type === 'turnEnded'))
    await session.close()
  })
})
