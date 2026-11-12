import { describe, expect, it } from 'vitest'
import {
  SettingsSchema,
  assessmentOutcome,
  settingsPolicy,
  policyVersion,
  type Settings,
} from '../src/policy/policy.ts'
import type { Mandate, SourceScope, Thread, Ticket, Trigger } from '../src/core/index.ts'

type Mode = Settings['policy']['acceptMode']
const direction = {
  implementation_requested: true,
  target_basis: 'specified',
  requires_design_decision: false,
  evidence: 'asked',
}
const judged = (current: Settings, matched: boolean) =>
  current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
const accept = (current: Settings, matched = true) => ({
  decision: 'accept' as const,
  rule_assessments: judged(current, matched),
  direction,
  title: 'Fix',
  scope: 'small',
  reason: 'asked',
  intent_evidence: 'quote',
  worktree_name: 'fix-copy',
})
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value) as T
}
const scope: SourceScope = { scope: () => ({ listened: true, observed: false }) }
const thread = (subscriptions: string[] = []): Thread => ({
  key: 'repo:1',
  ref: { source: 'repo', id: '1' },
  createdAt: '',
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
})
const repo = (login: string, overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'g',
  source: 'repo',
  threads: [{ source: 'repo', id: '1' }],
  actor: { source: 'repo', id: login },
  human: true,
  at: '',
  text: 'x',
  meta: { repository: 'acme/widgets', kind: 'conversation' },
  ...overrides,
})
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket
const observedScope: SourceScope = { scope: () => ({ listened: true, observed: true }) }
const settings = (mode: Mode): Settings => SettingsSchema.parse({ policy: { allowed: ['alice'], acceptMode: mode } })

describe('bots (AC6)', () => {
  const bots = (mode: Mode): Settings =>
    SettingsSchema.parse({ policy: { allowed: ['alice', 'dependabot[bot]', 'helper[bot]'], acceptMode: mode } })

  it.each(['observe', 'auto'] as const)(
    'admits a listed bot as an inferred candidate in %s mode, with or without a ticket',
    mode => {
      const policy = settingsPolicy(bots(mode), scope)
      const comment = repo('dependabot[bot]', { human: false, addressed: 'mention' })
      expect(policy.gate(comment, thread(), [])).toMatchObject({
        admissible: true,
        strength: 'inferred',
        basis: { via: 'bot' },
      })
      expect(policy.gate(comment, thread(), [])).not.toMatchObject({ strength: 'explicit' })
      expect(policy.gate(comment, thread(['ticket']), [ticket])).toMatchObject({
        admissible: true,
        strength: 'inferred',
        basis: { via: 'bot' },
      })
      expect(policy.gate(comment, thread(['ticket']), [ticket])).not.toMatchObject({ strength: 'explicit' })
      expect(policy.gate(repo('helper[bot]', { addressed: 'mention' }), thread(), [])).toMatchObject({
        admissible: true,
        strength: 'inferred',
        basis: { via: 'bot' },
      })
    },
  )

  it('ignores a listed bot in off mode', () => {
    expect(
      settingsPolicy(bots('off'), scope).gate(
        repo('dependabot[bot]', { human: false, addressed: 'mention' }),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'admission_ignored' })
  })

  it('accepts a bot candidate only in auto mode, on its matched rules', () => {
    const auto = bots('auto')
    const outcome = assessmentOutcome(accept(auto), auto)
    expect(outcome).toMatchObject({ kind: 'accept' })
    expect(outcome.kind === 'accept' && settingsPolicy(auto, scope).admitsInferred(outcome.rules ?? [])).toBe(true)
    const unmatched = assessmentOutcome(accept(auto, false), auto)
    expect(unmatched).toMatchObject({ kind: 'ignore', reason: { code: 'noRuleMatched' } })
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
  })

  it('records a bot candidate as would_accept in observe mode and never admits it as work', () => {
    const observe = bots('observe')
    const outcome = assessmentOutcome(accept(observe), observe)
    expect(outcome).toMatchObject({ kind: 'ignore', audit: { would_accept: true } })
    expect(outcome.kind).not.toBe('accept')
    const enabled = observe.policy.rules.filter(rule => rule.enabled).map(rule => rule.id)
    expect(settingsPolicy(observe, scope).admitsInferred(enabled)).toBe(false)
  })
})

describe('accept modes (AC7)', () => {
  it('gates an explicit request from a listed sender as explicit under every accept mode', () => {
    for (const mode of ['off', 'observe', 'auto'] as const) {
      expect(
        settingsPolicy(settings(mode), scope).gate(repo('alice', { addressed: 'mention' }), thread(), []),
      ).toMatchObject({ admissible: true, strength: 'explicit' })
    }
  })

  it('applies the accept mode to an explicit candidate: off ignores, observe records would_accept, auto accepts', () => {
    const off = settings('off')
    expect(assessmentOutcome(accept(off), off)).toMatchObject({
      kind: 'ignore',
      reason: 'Accept mode is off',
    })
    expect(assessmentOutcome(accept(off), off)).not.toHaveProperty('audit.would_accept')
    const observe = settings('observe')
    expect(assessmentOutcome(accept(observe), observe)).toMatchObject({
      kind: 'ignore',
      audit: { would_accept: true },
    })
    const auto = settings('auto')
    expect(assessmentOutcome(accept(auto), auto)).toMatchObject({ kind: 'accept' })
  })

  it('refuses only in accept mode auto', () => {
    expect(settingsPolicy(settings('auto'), scope).refuses).toBe(true)
    expect(settingsPolicy(settings('observe'), scope).refuses).toBe(false)
    expect(settingsPolicy(settings('off'), scope).refuses).toBe(false)
  })

  it('defaults to observe, which records would_accept', () => {
    const fromEmpty = SettingsSchema.parse({})
    const fromAllowed = SettingsSchema.parse({ policy: { allowed: ['alice'] } })
    expect(fromEmpty.policy.acceptMode).toBe('observe')
    expect(fromAllowed.policy.acceptMode).toBe('observe')
    expect(assessmentOutcome(accept(fromEmpty), fromEmpty)).toMatchObject({
      kind: 'ignore',
      audit: { would_accept: true },
    })
  })
})

describe('revalidate (AC8)', () => {
  const auto = SettingsSchema.parse({ policy: { allowed: ['alice'], acceptMode: 'auto' } })
  const copyRule = (overrides: Partial<Settings['policy']['rules'][number]>) =>
    auto.policy.rules.map(rule => (rule.id === 'copy' ? { ...rule, ...overrides } : rule))

  it('keeps an explicit Mandate while its sender stays on the allowed list, without mutating it', () => {
    const mandate: Mandate = deepFreeze<Mandate>({
      strength: 'explicit',
      policyVersion: 'v',
      basis: { via: 'addressed', source: 'repo', addressed: 'mention', sender: 'alice' },
      actor: { source: 'repo', id: 'alice' },
      scope: '',
    })
    const before = structuredClone(mandate)
    expect(settingsPolicy(auto, observedScope).revalidate(mandate)).toBe(true)
    expect(
      settingsPolicy({ ...auto, policy: { ...auto.policy, allowed: [] } }, observedScope).revalidate(mandate),
    ).toBe(false)
    expect(
      settingsPolicy({ ...auto, policy: { ...auto.policy, allowed: ['bob'] } }, observedScope).revalidate(mandate),
    ).toBe(false)
    expect(mandate).toEqual(before)
  })

  it('keeps an inferred Mandate only while auto mode, its matched rules and its sender hold', () => {
    const mandate: Mandate = deepFreeze<Mandate>({
      strength: 'inferred',
      policyVersion: 'v',
      basis: {
        via: 'admission',
        cell: 'listedUnaddressed',
        source: 'repo',
        rules: ['copy'],
        observation: { mode: 'auto' },
      },
      actor: { source: 'repo', id: 'alice' },
      scope: '',
    })
    const policyOf = (settings: Settings) => settingsPolicy(settings, observedScope)
    expect(policyOf(auto).revalidate(mandate)).toBe(true)
    expect(
      policyOf({
        ...auto,
        policy: { ...auto.policy, rules: auto.policy.rules.filter(rule => rule.id !== 'copy') },
      }).revalidate(mandate),
    ).toBe(false)
    expect(
      policyOf({ ...auto, policy: { ...auto.policy, rules: copyRule({ enabled: false }) } }).revalidate(mandate),
    ).toBe(false)
    expect(policyOf({ ...auto, policy: { ...auto.policy, allowed: [] } }).revalidate(mandate)).toBe(false)
    // R8: a changed instruction is reported by policyEffects and does not revoke the Mandate.
    expect(
      policyOf({
        ...auto,
        policy: { ...auto.policy, rules: copyRule({ instruction: 'A different instruction.' }) },
      }).revalidate(mandate),
    ).toBe(true)
  })
})

describe('policy version (AC8)', () => {
  const A = {
    policy: {
      allowed: ['alice'],
      acceptMode: 'auto',
      admission: {
        issues: { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore' },
        ci: { unlistedUnaddressed: 'inferred' },
      },
    },
  }
  const B = {
    policy: {
      admission: {
        ci: { unlistedUnaddressed: 'inferred' },
        issues: { unlistedAddressed: 'ignore', listedUnaddressed: 'inferred' },
      },
      acceptMode: 'auto',
      allowed: ['alice'],
    },
  }

  it('does not depend on the order keys were written in, at any depth', () => {
    // zod keeps record keys in input order (it reorders only z.object keys), so only the canonical sort makes A and B agree.
    expect(Object.keys(SettingsSchema.parse(A).policy.admission)).toEqual(['issues', 'ci'])
    expect(Object.keys(SettingsSchema.parse(B).policy.admission)).toEqual(['ci', 'issues'])
    const version = policyVersion(SettingsSchema.parse(A))
    expect(policyVersion(SettingsSchema.parse(B))).toBe(version)
    expect(version).toBe(policyVersion(SettingsSchema.parse(A)))
    expect(policyVersion(SettingsSchema.parse({ policy: { admission: { x: {}, y: {} } } }))).toBe(
      policyVersion(SettingsSchema.parse({ policy: { admission: { y: {}, x: {} } } })),
    )
  })

  it('changes with the allowed list and the accept mode, and not with pause or the eval timeout', () => {
    const version = policyVersion(SettingsSchema.parse(A))
    expect(policyVersion(SettingsSchema.parse({ policy: { ...A.policy, allowed: ['alice', 'bob'] } }))).not.toBe(
      version,
    )
    expect(policyVersion(SettingsSchema.parse({ policy: { ...A.policy, acceptMode: 'observe' } }))).not.toBe(version)
    expect(policyVersion(SettingsSchema.parse({ ...A, paused: true, eval: { timeoutSeconds: 300 } }))).toBe(version)
  })
})
