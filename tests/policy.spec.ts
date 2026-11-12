// Ported from dsh-superagent-prototype (MIT) tests/policy.spec.ts
/**
 * Ported policy spec (spec AC4). Reference: 40 `it` and 1 `it.each` (288 rows); 30 `it` and the `it.each` are kept.
 * Excluded (10): source scope L32, L40, L49 (Source registry install, enable and invalid configuration, and the discarded chat Source's scope; the registry is ported with sources/registry in M8);
 * settings migration L233, L249, L261, L267, L272 (migration.ts is discarded, ADR-2); L464 (Source kind UI hint text); L471 (repository Source scope rows, ported with the repository Source in M9).
 * Adapted (7): L54 (the sender name comes from the allowed entry string); L60 (one global allowed list, so an id allowed on one Source is allowed on all, charter A10);
 * L123 (gate expects kept, the two registry scope expects dropped); L224 (executor and Source-config fields are no longer in Settings; the Source-config case becomes a scope stub with the same settings);
 * L306 (SettingsSchema refusals kept, the three validatePolicy expects dropped until M8/M9); L315 (the accept mode now bears on explicit candidates: observe records would_accept, off records nothing). L84 (an automated message from a listed login is a listed bot, so it gates inferred; the not_human expect uses an unlisted sender).
 * Unchanged in meaning (names, ids and settings paths renamed only): the other 23 `it` and the `it.each` at L185.
 */
import { describe, expect, it } from 'vitest'
import {
  SettingsSchema,
  assessmentOutcome,
  policyEffects,
  settingsPolicy,
  policyVersion,
  allowedSender,
  anyoneAllowed,
  type Settings,
} from '../src/policy/policy.ts'
import type { MandateBasis, ScopeResult, SourceScope, Thread, Ticket, Trigger } from '../src/core/index.ts'

const MEMBER = 'alice'
const CHAT = 'team'
const OBSERVED = 'watched'
type ChatConfig = {
  chats: { chatId: string; listen: 'mentions' | 'all' }[]
  directMessages: boolean
  otherChats?: 'mentions'
}
type RepoConfig = { observeIssues?: boolean; observePulls?: boolean; observeComments?: boolean; observeCi?: boolean }
const DEFAULT_CHAT: ChatConfig = {
  chats: [
    { chatId: CHAT, listen: 'mentions' },
    { chatId: OBSERVED, listen: 'all' },
  ],
  directMessages: true,
}
// Port note: the reference SourceRegistry and its Source kinds are replaced by a stub reproducing their scope rules (spec A5).
function chatScope(config: ChatConfig, meta: Record<string, unknown>): ScopeResult {
  if (meta.direct === true)
    return config.directMessages
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'direct_messages_not_allowed' }
  const chat = config.chats.find(item => item.chatId === meta.chatId)
  if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
  return config.otherChats === 'mentions'
    ? { listened: true, observed: false, row: 'other' }
    : { listened: false, reason: 'chat_not_allowed' }
}
const REPO_ROWS = {
  issues: 'observeIssues',
  pulls: 'observePulls',
  comments: 'observeComments',
  ci: 'observeCi',
} as const
function repoRow(meta: Record<string, unknown>): keyof typeof REPO_ROWS | undefined {
  if (meta.ci === true) return typeof meta.branch === 'string' ? 'ci' : undefined
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}
function repoScope(config: RepoConfig, meta: Record<string, unknown>): ScopeResult {
  const row = repoRow(meta)
  return { listened: true, observed: row !== undefined && config[REPO_ROWS[row]] === true, ...(row ? { row } : {}) }
}
function scopes({ chat = DEFAULT_CHAT, repo = {} }: { chat?: ChatConfig; repo?: RepoConfig } = {}): SourceScope {
  return {
    scope: ({ source, meta }) =>
      source === 'chat'
        ? chatScope(chat, meta)
        : source === 'repo'
          ? repoScope(repo, meta)
          : { listened: true, observed: false },
  }
}
const base = SettingsSchema.parse({ policy: { allowed: ['Alice'], acceptMode: 'auto' } })
function setup(settings: Settings = base, scope: SourceScope = scopes()) {
  return { policy: settingsPolicy(settings, scope), version: policyVersion(settings) }
}
const { policy } = setup()
const thread = (subscriptions: string[] = []): Thread => ({
  key: 'chat:x',
  ref: { source: 'chat', id: 'x' },
  createdAt: '',
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
})
const chat = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({
  id: 't',
  source: 'chat',
  threads: [{ source: 'chat', id: 'x' }],
  actor: { source: 'chat', id: MEMBER },
  human: true,
  at: '',
  text: 'hi',
  addressed: 'mention',
  meta: { chatId: CHAT, direct: false, mentioned: true },
  ...overrides,
})
const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => {
  const { addressed: _addressed, ...rest } = chat(overrides)
  return rest
}
const repo = (login: string, addressed?: 'mention'): Trigger => ({
  id: 'g',
  source: 'repo',
  threads: [{ source: 'repo', id: '1' }],
  actor: { source: 'repo', id: login },
  human: true,
  at: '',
  text: 'x',
  ...(addressed ? { addressed } : {}),
  meta: { number: 1, isPr: true },
})
const ticket = { id: 'ticket', ended: { at: '', by: 'executor', reason: 'closed', outcome: 'closed' } } as Ticket

describe('gate', () => {
  it('grants explicit strength when the sender is allowed and the Source marked the Trigger addressed', () => {
    expect(policy.gate(chat(), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { via: 'addressed', source: 'chat', sender: 'Alice', addressed: 'mention', scope: { chatId: CHAT } },
    })
    expect(
      policy.gate(chat({ addressed: 'direct', meta: { chatId: 'p2p', direct: true, mentioned: false } }), thread(), []),
    ).toMatchObject({ admissible: true, strength: 'explicit', basis: { addressed: 'direct' } })
    // Logins compare without case; the allowed entry names the sender.
    expect(policy.gate(repo('alice', 'mention'), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { source: 'repo', sender: 'Alice' },
    })
  })
  it('checks one global list: an allowed login is allowed on every Source', () => {
    expect(policy.gate(repo('mallory', 'mention'), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(allowedSender(base, { source: 'repo', id: 'ALICE' })).toBe('Alice')
    expect(allowedSender(base, { source: 'chat', id: 'ALICE' })).toBe('Alice')
    expect(allowedSender(base, { source: 'chat', id: 'mallory' })).toBeUndefined()
    expect(anyoneAllowed(base)).toBe(true)
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false)
  })
  it('assesses follow-ups on Threads with Tickets, explicit from an allowed sender and inferred from anyone else', () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    expect(
      policy.gate(unaddressed({ ...quiet, actor: { source: 'chat', id: 'guest' } }), thread(['ticket']), []),
    ).toMatchObject({ admissible: true, strength: 'inferred', basis: { via: 'followup' } })
    expect(policy.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { via: 'followup', sender: 'Alice' },
    })
    expect(policy.gate(repo('someone'), thread(), [ticket])).toMatchObject({ admissible: true, strength: 'inferred' })
    // A Thread a ticket follows only for context lends no follow-up: the admission table decides, as on any Thread.
    const context = { ...thread(['ticket']), context: ['ticket'] }
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false })
  })
  it("infers strength for allowed senders' messages the Source observes, unless the accept mode is off", () => {
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } })
    expect(policy.gate(observed, thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'admission', observation: { mode: 'auto' } },
    })
    expect(
      setup({ ...base, policy: { ...base.policy, acceptMode: 'off' } }).policy.gate(observed, thread(), []),
    ).toEqual({ admissible: false, reason: 'no_mention' })
  })
  it('admits no direct message from a sender the allowed list does not allow, not even as a follow-up', () => {
    expect(
      policy.gate(
        chat({
          actor: { source: 'chat', id: 'guest' },
          addressed: 'direct',
          meta: { chatId: 'p2p', direct: true, mentioned: false },
        }),
        thread(['ticket']),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('rejects automated messages, unknown senders without a Thread, and allowed senders who did not address the agent', () => {
    expect(policy.gate(chat({ human: false, actor: { source: 'chat', id: 'guest' } }), thread(), [])).toEqual({
      admissible: false,
      reason: 'not_human',
    })
    // Port note: one global list (charter A10), so an automated message from a listed login is a listed bot: inferred at most (spec R2, R8).
    expect(policy.gate(chat({ human: false }), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'bot', sender: 'Alice', observation: { mode: 'auto' } },
    })
    expect(policy.gate(chat({ actor: { source: 'chat', id: 'guest' } }), thread(), [])).toEqual({
      admissible: false,
      reason: 'not_a_member',
    })
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual(
      { admissible: false, reason: 'no_mention' },
    )
  })
})
describe('admission table', () => {
  const STRANGER = 'stranger'
  const withTable = (admission: Record<string, Record<string, string>>, mode: 'off' | 'observe' | 'auto' = 'auto') =>
    SettingsSchema.parse({ ...base, policy: { ...base.policy, acceptMode: mode, admission } })
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = chat({
      actor: { source: 'chat', id: sender },
      meta: { chatId, direct: false, mentioned: addressed },
    })
    if (addressed) return message
    const { addressed: _addressed, ...rest } = message
    return rest
  }
  it('reproduces the behaviour before the table with every cell unset', () => {
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'admission', row: OBSERVED, cell: 'listedUnaddressed', observation: { mode: 'auto' } },
    })
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(
      policy.gate(
        chat({
          actor: { source: 'chat', id: STRANGER },
          addressed: 'direct',
          meta: { chatId: 'p2p', direct: true, mentioned: false },
        }),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'not_a_member' })
    // A listed sender who addresses the agent makes an explicit request whatever the table says.
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } })).policy.gate(inChat(CHAT), thread(), []),
    ).toMatchObject({ admissible: true, strength: 'explicit' })
  })
  it("makes an unlisted sender's mention explicit or inferred as the row says, and an inferred one waits for a mode that assesses", () => {
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).policy.gate(
      inChat(CHAT, STRANGER),
      thread(),
      [],
    )
    expect(explicit).toEqual({
      admissible: true,
      strength: 'explicit',
      basis: {
        source: 'chat',
        scope: { chatId: CHAT, direct: false, mentioned: true },
        row: CHAT,
        via: 'admission',
        cell: 'unlistedAddressed',
        addressed: 'mention',
      },
    })
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.gate(inChat(CHAT, STRANGER), thread(), []),
    ).toMatchObject({ admissible: true, strength: 'inferred', basis: { cell: 'unlistedAddressed' } })
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } }, 'off')).policy.gate(
        inChat(CHAT, STRANGER),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'not_a_member' })
    expect(
      setup(withTable({ direct: { unlistedAddressed: 'explicit' } })).policy.gate(
        chat({
          actor: { source: 'chat', id: STRANGER },
          addressed: 'direct',
          meta: { chatId: 'p2p', direct: true, mentioned: false },
        }),
        thread(),
        [],
      ),
    ).toMatchObject({ admissible: true, strength: 'explicit', basis: { row: 'direct', cell: 'unlistedAddressed' } })
    expect(
      setup(withTable({ [OBSERVED]: { unlistedAddressed: 'explicit' } })).policy.gate(
        inChat(CHAT, STRANGER),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it("ignores a listed sender's unaddressed message where the row says so, and never reads the table for messages the chat does not receive", () => {
    expect(
      setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore' } })).policy.gate(
        inChat(OBSERVED, MEMBER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'admission_ignored' })
    // An @-only chat receives no unaddressed message, so even an inferred cell does not admit one.
    expect(
      setup(withTable({ [CHAT]: { listedUnaddressed: 'inferred' } })).policy.gate(
        inChat(CHAT, MEMBER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'no_mention' })
    expect(
      setup(withTable({ [CHAT]: { unlistedUnaddressed: 'inferred' } })).policy.gate(
        inChat(CHAT, STRANGER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: 'not_a_member' })
  })
  it('listens to mentions in chats that are not listed, as the row other, only when the chat scope says so', () => {
    const others = setup(
      withTable({ other: { unlistedAddressed: 'explicit' } }),
      scopes({ chat: { ...DEFAULT_CHAT, otherChats: 'mentions' } }),
    )
    expect(others.policy.gate(inChat('elsewhere'), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { row: 'other' },
    })
    expect(others.policy.gate(inChat('elsewhere', STRANGER), thread(), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { row: 'other', cell: 'unlistedAddressed' },
    })
  })
  it("admits no inferred follow-up while Eval is off, as no other inferred candidate, and still a listed sender's", () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } }
    const off = setup({ ...base, policy: { ...base.policy, acceptMode: 'off' } }).policy
    expect(off.gate(unaddressed({ ...quiet, actor: { source: 'chat', id: 'guest' } }), thread(['ticket']), [])).toEqual(
      { admissible: false, reason: 'not_a_member' },
    )
    expect(off.gate(unaddressed(quiet), thread(['ticket']), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { via: 'followup' },
    })
  })
  it("makes an explicit request of an unlisted sender's message whose cell is explicit, also on a Thread with Tickets, in every mode", () => {
    for (const mode of ['auto', 'observe', 'off'] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } }, mode))
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject({
        admissible: true,
        strength: 'explicit',
        basis: { via: 'admission', cell: 'unlistedAddressed' },
      })
      // A cell that is not explicit leaves the follow-up inferred, while Eval is on.
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: 'ignore' } }, mode))
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(['ticket']), [])).toMatchObject(
        mode === 'off' ? { admissible: false } : { admissible: true, strength: 'inferred', basis: { via: 'followup' } },
      )
    }
  })
  it('keeps follow-ups on a Thread with Tickets outside the table', () => {
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: 'ignore', unlistedUnaddressed: 'ignore' } }))
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(['ticket']), [])).toMatchObject({
      admissible: true,
      strength: 'explicit',
      basis: { via: 'followup' },
    })
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(['ticket']), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'followup' },
    })
  })
  it('invalidates a Mandate once its cell gives less than the strength it was accepted with, and keeps it while the cell holds', () => {
    const open = withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), [])
    if (!gate.admissible) throw new Error('expected admission')
    const mandate = {
      strength: gate.strength,
      policyVersion: 'v',
      basis: gate.basis,
      actor: { source: 'chat', id: STRANGER },
      scope: '',
    }
    expect(setup(open).policy.revalidate(mandate)).toBe(true)
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'inferred' } })).policy.revalidate(mandate)).toBe(false)
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false)
  })
  it('changes the Policy version when a cell changes', () => {
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: 'explicit' } })).version).not.toBe(setup().version)
    expect(setup(withTable({})).version).toBe(setup().version)
  })
})
describe('revalidating a Mandate from the admission table', () => {
  type Cell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
  const cells: Cell[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed']
  const SENDER = 'sender'
  const origins: { cell: Cell; strength: 'explicit' | 'inferred' }[] = [
    { cell: 'listedUnaddressed', strength: 'inferred' },
    { cell: 'unlistedAddressed', strength: 'explicit' },
    { cell: 'unlistedAddressed', strength: 'inferred' },
    { cell: 'unlistedUnaddressed', strength: 'inferred' },
  ]
  const cases = origins.flatMap(origin =>
    [true, false].flatMap(listed =>
      (['off', 'observe', 'auto'] as const).flatMap(mode =>
        [true, false].flatMap(rule =>
          (['all', 'mentions', 'none'] as const).flatMap(scope =>
            [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })),
          ),
        ),
      ),
    ),
  )
  /** docs/002: the Thread must still be received; a listed sender who addresses the agent is explicit; a sender listed since takes the listed cell. */
  function expected({ cell, strength, listed, mode, rule, scope, holds }: (typeof cases)[number]): boolean {
    if (scope === 'none') return false
    if (cell === 'unlistedAddressed' && listed) return true
    const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
    if ((now === 'listedUnaddressed' && !listed) || !holds) return false
    return strength === 'explicit' || (mode === 'auto' && rule)
  }
  it.each(cases)(
    '$cell ($strength), listed now $listed, mode $mode, rule on $rule, chat receives $scope, cell holds $holds',
    item => {
      // The row gives each cell the strength the Mandate was accepted with, or, when it no longer holds, ignore.
      const grant = (cell: Cell) => (!item.holds ? 'ignore' : cell === 'unlistedAddressed' ? item.strength : 'inferred')
      const chats = item.scope === 'none' ? [] : [{ chatId: CHAT, listen: item.scope }]
      const settings = SettingsSchema.parse({
        policy: {
          acceptMode: item.mode,
          rules: [{ id: 'copy', name: 'Copy', enabled: item.rule, instruction: 'x' }],
          allowed: item.listed ? [SENDER] : [],
          admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) },
        },
      })
      const addressed = item.cell === 'unlistedAddressed'
      const observed = item.strength === 'inferred' ? { observation: { mode: 'auto' as const }, rules: ['copy'] } : {}
      const basis: MandateBasis = {
        via: 'admission',
        source: 'chat',
        scope: { chatId: CHAT, direct: false, mentioned: addressed },
        row: CHAT,
        cell: item.cell,
        ...(addressed ? { addressed: 'mention' as const } : {}),
        ...observed,
      }
      const mandate = {
        strength: item.strength,
        policyVersion: 'v',
        basis,
        actor: { source: 'chat', id: SENDER },
        scope: '',
      }
      expect(setup(settings, scopes({ chat: { chats, directMessages: true } })).policy.revalidate(mandate)).toBe(
        expected(item),
      )
    },
  )
})
describe('revalidate and version', () => {
  it('keeps explicit Mandates while the sender stays allowed and the Source still listens, and rule Mandates only while auto mode and the rules hold', () => {
    const basis: MandateBasis = {
      via: 'addressed',
      source: 'chat',
      scope: { chatId: CHAT, direct: false },
      sender: 'Alice',
      addressed: 'mention',
    }
    const mandate = {
      strength: 'explicit' as const,
      policyVersion: 'v',
      basis,
      actor: { source: 'chat', id: MEMBER },
      scope: '',
    }
    expect(policy.revalidate(mandate)).toBe(true)
    const nobody = { ...base, policy: { ...base.policy, allowed: [] } }
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false)
    const silent = setup(base, scopes({ chat: { chats: [], directMessages: true } }))
    expect(silent.policy.revalidate(mandate)).toBe(false)
    // A Mandate from before the gate recorded how it admitted a Trigger holds while its sender is listed and the Source listens.
    const listed: MandateBasis = {
      via: 'listed',
      source: 'chat',
      scope: { chatId: CHAT, direct: false },
      sender: 'Alice',
    }
    expect(silent.policy.revalidate({ ...mandate, basis: listed })).toBe(false)
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true)
    const inferred = {
      ...mandate,
      strength: 'inferred' as const,
      basis: { via: 'listed', observation: {}, rules: ['copy'] } satisfies MandateBasis,
    }
    expect(policy.revalidate(inferred)).toBe(true)
    expect(setup({ ...base, policy: { ...base.policy, acceptMode: 'observe' } }).policy.revalidate(inferred)).toBe(
      false,
    )
    expect(
      setup({
        ...base,
        policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) },
      }).policy.revalidate(inferred),
    ).toBe(false)
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: 'followup' } })).toBe(true)
  })
  it('changes the Policy version for rules, accept mode and the allowed list, not for pause, timeouts or Source scope', () => {
    const version = setup().version
    expect(setup({ ...base, paused: true, eval: { ...base.eval, timeoutSeconds: 300 } }).version).toBe(version)
    expect(setup(base, scopes({ chat: { chats: [], directMessages: false } })).version).toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, acceptMode: 'off' } }).version).not.toBe(version)
    expect(setup({ ...base, policy: { ...base.policy, allowed: [] } }).version).not.toBe(version)
  })
})
describe('assessment outcomes', () => {
  const settings = (mode: 'auto' | 'observe') => {
    const parsed = SettingsSchema.parse({})
    return { ...parsed, policy: { ...parsed.policy, acceptMode: mode } }
  }
  const direction = {
    implementation_requested: true,
    target_basis: 'specified',
    requires_design_decision: false,
    evidence: 'asked',
  }
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: 'judged' }))
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({
    decision: 'accept' as const,
    rule_assessments: judged(current, matched),
    direction,
    title: 'Fix',
    scope: 'small',
    reason: 'asked',
    intent_evidence: 'quote',
    worktree_name: 'fix-copy',
  })
  it('accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules', () => {
    const auto = settings('auto')
    const outcome = assessmentOutcome(accept(auto), auto)
    expect(outcome).toMatchObject({
      kind: 'accept',
      rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id),
      name: 'fix-copy',
    })
    expect(assessmentOutcome(accept(settings('observe')), settings('observe'))).toMatchObject({
      kind: 'ignore',
      reason: { code: 'observed', values: { text: 'asked' } },
      audit: { would_accept: true },
    })
    expect(assessmentOutcome(accept(auto, false), auto)).toMatchObject({
      kind: 'ignore',
      reason: { code: 'noRuleMatched' },
    })
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto)).toThrow(
      'Exactly one assessment for every enabled rule',
    )
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto)).toThrow(
      'Acceptance requires intent_evidence',
    )
    const scope = { scope: () => ({ listened: true as const, observed: true }) }
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true)
    expect(settingsPolicy(auto, scope).admitsInferred(['unknown'])).toBe(false)
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false)
    expect(settingsPolicy(settings('observe'), scope).admitsInferred([enabled])).toBe(false)
  })
})
describe('admission table settings', () => {
  it('refuses an explicit cell for messages that do not address the agent in the settings', () => {
    for (const cell of ['listedUnaddressed', 'unlistedUnaddressed']) {
      expect(() => SettingsSchema.parse({ policy: { admission: { [CHAT]: { [cell]: 'explicit' } } } })).toThrow()
    }
    expect(
      SettingsSchema.parse({ policy: { admission: { [CHAT]: { unlistedAddressed: 'explicit' } } } }).policy.admission,
    ).toMatchObject({ [CHAT]: { unlistedAddressed: 'explicit' } })
  })
  it('applies the accept mode to explicit and inferred candidates alike', () => {
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled)
    const direction = {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: 'asked',
    }
    const assessment = {
      decision: 'accept' as const,
      direction,
      title: 'Fix',
      scope: 'small',
      reason: 'asked',
      intent_evidence: 'quote',
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: 'judged' })),
    }
    const auto = SettingsSchema.parse({ policy: { acceptMode: 'auto' } })
    const observe = SettingsSchema.parse({ policy: { acceptMode: 'observe' } })
    const off = SettingsSchema.parse({ policy: { acceptMode: 'off' } })
    expect(assessmentOutcome(assessment, auto)).toMatchObject({ kind: 'accept', title: 'Fix' })
    for (const strength of ['explicit', 'inferred'] as const) {
      expect(assessmentOutcome(assessment, observe)).toMatchObject({
        kind: 'ignore',
        reason: { code: 'observed' },
        audit: { would_accept: true },
      })
      expect(assessmentOutcome(assessment, off)).toMatchObject({
        kind: 'ignore',
        reason: 'Accept mode is off',
      })
      expect(assessmentOutcome(assessment, off).audit?.would_accept).toBeUndefined()
    }
  })
  it("admits a listed bot that mentions the agent where the Source does not observe its messages, as a listed person's mention needs none", () => {
    const settings = SettingsSchema.parse({
      ...base,
      policy: { ...base.policy, allowed: [...base.policy.allowed, 'cli_alerts'] },
    })
    const mention = chat({
      actor: { source: 'chat', id: 'cli_alerts' },
      human: false,
      meta: { chatId: CHAT, direct: false, mentioned: true },
    })
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention', row: CHAT },
    })
  })
})
describe('rule judgements', () => {
  it('refuses an assessment that judges one enabled rule twice and leaves another unjudged', () => {
    const parsed = SettingsSchema.parse({
      policy: {
        acceptMode: 'auto',
        rules: [
          { id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
          { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' },
        ],
      },
    })
    const direction = {
      implementation_requested: true,
      target_basis: 'specified',
      requires_design_decision: false,
      evidence: 'asked',
    }
    const assessment = {
      decision: 'accept' as const,
      direction,
      title: 'Fix',
      scope: 'small',
      reason: 'asked',
      intent_evidence: 'quote',
      rule_assessments: [
        { rule_id: 'copy', matched: true, reason: 'typo' },
        { rule_id: 'copy', matched: false, reason: 'again' },
      ],
    }
    expect(() => assessmentOutcome(assessment, parsed)).toThrow('Exactly one assessment for every enabled rule')
    const once = {
      ...assessment,
      rule_assessments: [assessment.rule_assessments[0]!, { rule_id: 'visual', matched: false, reason: 'no colors' }],
    }
    expect(assessmentOutcome(once, parsed)).toMatchObject({ kind: 'accept', rules: ['copy'] })
  })
})
describe('policy effects', () => {
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) })
  const base = SettingsSchema.parse({
    policy: {
      rules: [
        { id: 'copy', name: 'Copy', enabled: true, instruction: 'Fix typos.' },
        { id: 'visual', name: 'Visual', enabled: true, instruction: 'Fix colors.' },
      ],
      allowed: ['alice'],
    },
  })
  const ticket = (id: string, mandate: object) => ({ id, mandate }) as unknown as Ticket
  const inferred = ticket('t1', {
    strength: 'inferred',
    actor: { source: 'chat', id: 'guest' },
    basis: { via: 'listed', rules: ['copy'] },
  })
  const explicit = ticket('t2', {
    strength: 'explicit',
    actor: { source: 'chat', id: 'alice' },
    basis: { via: 'listed', source: 'chat' },
  })
  it('tells a ticket how a change bears on it, and leaves the others alone', () => {
    const rules = (copy: object, visual: object = {}) => ({
      ...base,
      policy: {
        ...base.policy,
        rules: [
          { ...base.policy.rules[0]!, ...copy },
          { ...base.policy.rules[1]!, ...visual },
        ],
      },
    })
    // A rule the ticket was not accepted under changes nothing for it.
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0)
    expect(policyEffects([inferred], base, rules({ instruction: 'Fix typos only.' }), scope).get('t1')).toEqual({
      rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'Fix typos only.' }],
    })
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get('t1')).toEqual({
      rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }],
    })
    // Another sender on the list, as a member sync adds, bears on no ticket; taking the requester off it does.
    const allowed = (list: string[]) => ({ ...base, policy: { ...base.policy, allowed: list } })
    expect(policyEffects([inferred, explicit], base, allowed(['alice', 'bob']), scope).size).toBe(0)
    expect(policyEffects([explicit], base, allowed([]), scope).get('t2')).toEqual({
      requesterAllowed: false,
      requester: { source: 'chat', id: 'alice' },
    })
  })
  it('tells an inferred ticket that inferred work is no longer accepted when the accept mode leaves auto, and names a bot it is for', () => {
    const auto = { ...base, policy: { ...base.policy, acceptMode: 'auto' as const } }
    const observe = { ...base, policy: { ...base.policy, acceptMode: 'observe' as const } }
    const rule = ticket('t3', {
      strength: 'inferred',
      actor: { source: 'chat', id: 'alice' },
      basis: { via: 'listed', source: 'chat', rules: ['copy'], observation: {} },
    })
    const effects = policyEffects([rule, explicit], auto, observe, scope)
    // Not a sender's removal: the person who wrote it may still start work.
    expect(effects.get('t3')).toEqual({ proactive: false })
    expect(effects.has('t2')).toBe(false)
    const bot = ticket('t4', {
      strength: 'explicit',
      actor: { source: 'chat', id: 'ci-bot' },
      basis: { via: 'listed', source: 'chat' },
    })
    const listed = { ...base, policy: { ...base.policy, allowed: ['ci-bot'] } }
    expect(policyEffects([bot], listed, base, scope).get('t4')).toEqual({
      requesterAllowed: false,
      requester: { source: 'chat', id: 'ci-bot' },
    })
  })
  it("keeps an inferred follow-up's Mandate only while candidates become work and its rules are on, as any inferred one", () => {
    const followup = ticket('t5', {
      strength: 'inferred',
      actor: { source: 'chat', id: 'guest' },
      scope: '',
      basis: { via: 'followup', source: 'chat', scope: { chatId: CHAT }, rules: ['copy'] },
    })
    const mode = (value: 'auto' | 'observe' | 'off') => ({ ...base, policy: { ...base.policy, acceptMode: value } })
    const disabled = {
      ...mode('auto'),
      policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== 'copy' })) },
    }
    expect(settingsPolicy(mode('auto'), scope()).revalidate(followup.mandate)).toBe(true)
    for (const settings of [mode('observe'), mode('off'), disabled])
      expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false)
    expect(policyEffects([followup], mode('auto'), mode('observe'), scope).get('t5')).toEqual({ proactive: false })
    // An explicit follow-up holds whatever the mode.
    const explicitFollowup = ticket('t6', {
      ...followup.mandate,
      strength: 'explicit',
      actor: { source: 'chat', id: 'alice' },
    })
    expect(settingsPolicy(mode('off'), scope()).revalidate(explicitFollowup.mandate)).toBe(true)
  })
  it('revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled', () => {
    const room = 'room'
    const table = (cell: 'inferred' | 'ignore', mode: 'auto' | 'observe' = 'auto') =>
      SettingsSchema.parse({
        ...base,
        policy: { ...base.policy, acceptMode: mode, admission: { [room]: { unlistedUnaddressed: cell } } },
      })
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: room }) })
    const proactive = ticket('t3', {
      strength: 'inferred',
      actor: { source: 'chat', id: 'guest' },
      scope: '',
      basis: {
        via: 'admission',
        cell: 'unlistedUnaddressed',
        source: 'chat',
        scope: { chatId: room },
        row: room,
        rules: ['copy'],
        observation: { mode: 'auto' },
      },
    })
    expect(policyEffects([proactive], table('inferred'), table('inferred'), observed).size).toBe(0)
    // A weaker cell takes the work from its sender, whom the effect names; a mode change only stops inferred work.
    expect(policyEffects([proactive], table('inferred'), table('ignore'), observed).get('t3')).toEqual({
      requesterAllowed: false,
      requester: { source: 'chat', id: 'guest' },
    })
    expect(policyEffects([proactive], table('inferred'), table('inferred', 'observe'), observed).get('t3')).toEqual({
      proactive: false,
    })
    const deleted = {
      ...base,
      policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== 'visual') },
    }
    const visual = ticket('t4', {
      strength: 'explicit',
      actor: { source: 'chat', id: 'alice' },
      basis: { via: 'listed', source: 'chat', rules: ['visual'] },
    })
    expect(policyEffects([visual], base, deleted, scope).get('t4')).toEqual({
      rules: [{ id: 'visual', name: 'Visual', change: 'disabled' }],
    })
  })
})
describe('bots and events without a sender', () => {
  const observing = (repo: RepoConfig, policy: Record<string, unknown> = {}, mode: 'auto' | 'off' = 'auto') =>
    setup(
      SettingsSchema.parse({ policy: { allowed: ['Alice', 'dependabot[bot]'], acceptMode: mode, ...policy } }),
      scopes({ repo }),
    )
  const comment: Trigger = {
    id: 'b',
    source: 'repo',
    threads: [{ source: 'repo', id: '1' }],
    actor: { source: 'repo', id: 'dependabot[bot]' },
    human: false,
    at: '',
    text: 'Bump lodash',
    meta: { number: 1, isPr: true, kind: 'conversation' },
  }
  const ci = (meta: Record<string, unknown>): Trigger => ({
    id: 'ci',
    source: 'repo',
    threads: [{ source: 'repo', id: 'ci:main' }],
    actor: { source: 'repo', id: '' },
    human: false,
    at: '',
    text: 'CI failed 1/9 on main',
    meta: { ci: true, ...meta },
  })
  it('admits a bot on its list as an inferred candidate where the Source observes its scope, and no other bot', () => {
    const { policy } = observing({ observeComments: true })
    expect(policy.gate(comment, thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'bot', source: 'repo', sender: 'dependabot[bot]', row: 'comments', observation: { mode: 'auto' } },
    })
    // A bot that addresses the agent still makes no explicit request; on a Thread with tickets it is no follow-up either.
    expect(policy.gate({ ...comment, addressed: 'mention' }, thread(['ticket']), [ticket])).toMatchObject({
      strength: 'inferred',
      basis: { via: 'bot', addressed: 'mention' },
    })
    expect(policy.gate({ ...comment, actor: { source: 'repo', id: 'renovate[bot]' } }, thread(), [])).toEqual({
      admissible: false,
      reason: 'not_human',
    })
    expect(observing({}).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: 'not_human' })
    expect(observing({ observeComments: true }, {}, 'off').policy.gate(comment, thread(), [])).toEqual({
      admissible: false,
      reason: 'admission_ignored',
    })
  })
  it("keeps a bot candidate's Mandate while the bot stays on its list and candidates may become work", () => {
    const { policy } = observing({ observeComments: true })
    const mandate = {
      strength: 'inferred' as const,
      policyVersion: '',
      actor: comment.actor,
      scope: '',
      basis: {
        via: 'bot' as const,
        source: 'repo',
        scope: comment.meta,
        row: 'comments',
        sender: 'dependabot[bot]',
        observation: { mode: 'auto' as const },
      },
    }
    expect(policy.revalidate(mandate)).toBe(true)
    expect(observing({ observeComments: true }, { allowed: ['Alice'] }).policy.revalidate(mandate)).toBe(false)
    expect(observing({ observeComments: true }, { acceptMode: 'observe' }).policy.revalidate(mandate)).toBe(false)
  })
  it("admits the default branch's CI through its row once observed and set, and never a PR's CI", () => {
    const admission = { ci: { unlistedUnaddressed: 'inferred' } }
    const branch = observing({ observeCi: true }, { admission }).policy.gate(ci({ branch: 'main' }), thread(), [])
    expect(branch).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'admission', cell: 'unlistedUnaddressed', row: 'ci', observation: { mode: 'auto' } },
    })
    // The cell defaults to ignore, so observing the CI changes nothing until the table says so.
    expect(observing({ observeCi: true }).policy.gate(ci({ branch: 'main' }), thread(), [])).toEqual({
      admissible: false,
      reason: 'admission_ignored',
    })
    const pull = observing({ observeCi: true }, { admission }).policy.gate(ci({ number: 9, isPr: true }), thread(), [])
    expect(pull).toEqual({ admissible: false, reason: 'not_human' })
  })
  it('admits a chat bot on its list in a chat the Source observes', () => {
    const settings = SettingsSchema.parse({
      ...base,
      policy: { ...base.policy, allowed: [...base.policy.allowed, 'Alerts'] },
    })
    const alert = unaddressed({
      actor: { source: 'chat', id: 'alerts' },
      human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false },
    })
    expect(setup(settings).policy.gate(alert, thread(), [])).toMatchObject({
      admissible: true,
      strength: 'inferred',
      basis: { via: 'bot', sender: 'Alerts', row: OBSERVED },
    })
    // In a chat the Source receives only mentions in, a bot's message that does not address the agent is not received.
    const unobserved = setup(settings).policy.gate(
      { ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } },
      thread(),
      [],
    )
    expect(unobserved).toEqual({ admissible: false, reason: 'not_human' })
  })
})
