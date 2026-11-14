/** The offline rules of the live environment-block judgment and its scenario verdict part. */
import { describe, expect, it } from 'vitest'
import { environmentBlockedText } from '../src/core/replies.ts'
import { judgeEnvironmentBlock } from './live/environment-evidence.ts'
import type { EnvironmentBlockInput } from './live/environment-evidence.ts'
import { judgeScenario, loadAllScenarios, scenarioProblems } from './live/scenarios.ts'
import type { LiveScenario } from './live/scenarios.ts'

const AGENT = 'bot'
const PULL = 'https://example.test/pull/7'
const DETAIL = 'protoc missing'

const good = (): EnvironmentBlockInput => ({
  ticketId: 't1',
  agent: AGENT,
  log: [{ event: 'worker.environment_blocked', level: 'warn', ticketId: 't1', assignmentId: 'a', detail: DETAIL }],
  comments: [
    { body: 'On it.\n\n<!-- issuecrew:x -->', user: { login: AGENT } },
    { body: environmentBlockedText(PULL) + '\n\n<!-- issuecrew:environment-blocked:a:1 -->', user: { login: AGENT } },
    { body: 'please install it', user: { login: 'owner' } },
  ],
  pull: { html_url: PULL, title: 'Add the health schema', body: 'Not done: code generation was not run.' },
  needs: { label: 'Environment blocked', text: DETAIL },
})

const S: LiveScenario = {
  id: 'environment-blocked',
  tier: 'extended',
  issue: { title: 't', body: 'b' },
  diff: { requireSourceAndTest: false },
  environmentBlock: true,
}

const base = { checks: 'failure', hidden: null, diff: { pass: true }, base: null }

describe('live environment-block judgment', () => {
  it('passes a run with one warn record, one neutral note, needs and clean texts', () => {
    const v = judgeEnvironmentBlock(good())
    expect(v).toEqual({ passed: true, problems: [], manual: expect.any(Array), records: 1, notes: 1, detail: DETAIL })
    expect(v.manual[0]).toContain(PULL)
  })

  it('fails when the worker never reported an environment block', () => {
    const v = judgeEnvironmentBlock({ ...good(), log: [] })
    expect(v.passed).toBe(false)
    expect(v.problems[0]).toContain('never reported an environment block')
  })

  it('ignores a record for another ticket', () => {
    const input = good()
    input.log = [{ ...input.log[0], ticketId: 't2' }]
    const v = judgeEnvironmentBlock(input)
    expect(v.problems[0]).toContain('never reported an environment block')
  })

  it('fails a record that is not warn or has no detail', () => {
    const info = good()
    info.log = [{ ...info.log[0], level: 'info' }]
    expect(judgeEnvironmentBlock(info).problems.join('\n')).toContain('not warn')
    const bare = good()
    bare.log = [{ event: 'worker.environment_blocked', level: 'warn', ticketId: 't1' }]
    expect(judgeEnvironmentBlock(bare).problems.join('\n')).toContain('has no detail')
  })

  it('requires exactly one neutral note', () => {
    const twice = good()
    twice.comments.push({ body: environmentBlockedText(PULL), user: { login: AGENT } })
    expect(judgeEnvironmentBlock(twice).problems).toContain(
      'the issue has 2 neutral environment notes, expected exactly 1',
    )
    const none = good()
    none.comments = none.comments.filter(c => c.user?.login !== AGENT || !(c.body ?? '').includes('environment'))
    expect(judgeEnvironmentBlock(none).problems.join('\n')).toContain('has 0 neutral')
    const plain = good()
    plain.comments = [{ body: environmentBlockedText(), user: { login: AGENT } }]
    expect(judgeEnvironmentBlock(plain).passed).toBe(true)
  })

  it('rejects host setting names, install requests and a repeated detail', () => {
    const prBody = good()
    prBody.pull = { ...prBody.pull!, body: 'Add proxy.golang.org to network.allow.' }
    expect(judgeEnvironmentBlock(prBody).problems.join('\n')).toContain('PR body names host setting network.allow')
    const ask = good()
    ask.comments.push({ body: 'Could you install protoc on the host?', user: { login: AGENT } })
    expect(judgeEnvironmentBlock(ask).problems.join('\n')).toContain('asks someone to install or allow something')
    const repeat = good()
    repeat.comments.push({ body: 'Blocked by ' + DETAIL, user: { login: AGENT } })
    expect(judgeEnvironmentBlock(repeat).problems).toContain('a worker comment repeats the operator-only detail')
  })

  it('checks the needs item shows the block with the reported detail', () => {
    const none = good()
    none.needs = undefined
    expect(judgeEnvironmentBlock(none).problems).toContain(
      'needs does not show Environment blocked for the ticket (label: none)',
    )
    const other = good()
    other.needs = { label: 'Environment blocked', text: 'other' }
    expect(judgeEnvironmentBlock(other).problems.join('\n')).toContain('needs text differs')
  })

  it('makes the environment part decide the scenario verdict', () => {
    expect(judgeScenario(S, { ...base, environment: { passed: true } })).toEqual({ passed: true, failed: [] })
    expect(judgeScenario(S, { ...base, environment: { passed: false } }).failed).toEqual(['environment-block'])
    expect(judgeScenario(S, { ...base, environment: null }).failed).toContain('environment-block')
    const plain = { ...S, environmentBlock: undefined }
    expect(judgeScenario(plain, base).failed).toEqual(['checks'])
  })

  it('validates the environmentBlock flag and loads the registered scenario', async () => {
    expect(scenarioProblems({ ...S, environmentBlock: 'yes' })).toContain('environmentBlock must be true')
    const all = await loadAllScenarios()
    expect(all.find(s => s.id === 'environment-blocked')?.environmentBlock).toBe(true)
  })
})
