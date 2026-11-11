import { describe, expect, expectTypeOf, it } from 'vitest'
import { actorVerdict, type ActorRule } from '../src/policy/actors.ts'
import type { Trigger } from '../src/core/index.ts'

const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 't',
  source: 'repo',
  threads: [{ source: 'repo', id: '1' }],
  actor: { source: 'repo', id: 'alice' },
  human: true,
  at: '',
  text: 'hi',
  meta: { repository: 'acme/widgets' },
  ...overrides,
})
const RULE: ActorRule = { allowed: ['Alice', 'renovate[bot]'], repositories: ['acme/widgets'] }

describe('actor verdicts', () => {
  it.each([
    ['unlisted person', { actor: { source: 'repo', id: 'mallory' } }, 'rejected-actor'],
    ['unlisted bot by suffix', { actor: { source: 'repo', id: 'dependabot[bot]' }, human: false }, 'rejected-bot'],
    ['unlisted bot by account type', { actor: { source: 'repo', id: 'helper' }, human: false }, 'rejected-bot'],
    ['suffix wins over a human flag', { actor: { source: 'repo', id: 'sneaky[bot]' }, human: true }, 'rejected-bot'],
    ['repository outside the list, allowed actor', { meta: { repository: 'other/repo' } }, 'rejected-repo'],
    ['no repository', { meta: {} }, 'rejected-repo'],
    [
      'unlisted actor outside the list',
      { actor: { source: 'repo', id: 'mallory' }, meta: { repository: 'other/repo' } },
      'rejected-repo',
    ],
    ['listed person', {}, 'allowed'],
    ['listed person, case variant', { actor: { source: 'repo', id: 'ALICE' } }, 'allowed'],
    ['listed bot', { actor: { source: 'repo', id: 'renovate[bot]' }, human: false }, 'allowed'],
    ['listed bot, case variant', { actor: { source: 'repo', id: 'Renovate[BOT]' }, human: false }, 'allowed'],
    ['CI transition', { actor: { source: 'repo', id: '' }, human: false }, 'source-fact'],
    [
      'CI transition outside the list',
      { actor: { source: 'repo', id: '' }, human: false, meta: { repository: 'other/repo' } },
      'rejected-repo',
    ],
    ['repository case variant', { meta: { repository: 'ACME/Widgets' } }, 'allowed'],
  ])('%s', (_name, overrides, expected) => {
    expect(actorVerdict(trigger(overrides), RULE)).toBe(expected)
  })

  it('takes no authentication mode', () => {
    expect(actorVerdict.length).toBe(2)
    expectTypeOf(actorVerdict).parameters.toEqualTypeOf<[Trigger, ActorRule]>()
    expectTypeOf<keyof ActorRule>().toEqualTypeOf<'allowed' | 'repositories'>()
  })
})
