/**
 * Team prompt sections changed while worker sessions are open: the host queues one notice per open ticket,
 * injected into the running session without starting a turn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConfigSchema } from '../src/app/config.ts'
import { Runtime } from '../src/app/runtime.ts'
import { FakeRuntime, type FakeScript, type FakeSession } from '../src/runtimes/fake/runtime.ts'
import { deferred, waitUntil } from './fixtures/async.ts'
import { trigger } from './fixtures/engine.ts'
import { testSource } from './fixtures/source.ts'

let runtime: Runtime | undefined
let directory: string | undefined
let gate = deferred()

afterEach(async () => {
  gate.resolve()
  await runtime?.stop()
  runtime = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

function teamFile(section: string, text: string): void {
  mkdirSync(join(directory!, 'config', 'prompts', 'team'), { recursive: true })
  writeFileSync(join(directory!, 'config', 'prompts', 'team', `${section}.md`), text)
}

function noteFile(repository: string, text: string): void {
  const [owner, name] = repository.split('/')
  mkdirSync(join(directory!, 'config', 'prompts', 'environment', owner!), { recursive: true })
  writeFileSync(join(directory!, 'config', 'prompts', 'environment', owner!, `${name}.md`), text)
}

async function boot(given?: FakeScript, options: { repositories?: string[]; notes?: Record<string, string> } = {}) {
  directory = mkdtempSync(join(tmpdir(), 'prompt-notice-'))
  teamFile('communication', 'Team communication A')
  for (const [repository, text] of Object.entries(options.notes ?? {})) noteFile(repository, text)
  gate = deferred()
  const script: FakeScript =
    given ??
    (({ index }) =>
      index === 0
        ? { hold: gate.promise }
        : { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'done' } }] })
  const config = ConfigSchema.parse({
    repositories: options.repositories ?? ['owner/repo'],
    policy: { allowed: ['alice'], acceptMode: 'auto' },
    stateDir: join(directory, 'state'),
  })
  const chat = testSource()
  const fake = new FakeRuntime(script)
  runtime = new Runtime({
    config,
    configDir: join(directory, 'config'),
    runtime: fake,
    kinds: [chat.kind],
    services: [chat.service],
  })
  await runtime.start()
  return { r: runtime, chat, fake }
}

async function openSession(chat: ReturnType<typeof testSource>, fake: FakeRuntime): Promise<FakeSession> {
  chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => fake.sessions.length === 1)
  return fake.sessions[0]!
}

function promptRows(r: Runtime): { hash: string; parts_json: string }[] {
  return r.store.db.prepare('SELECT hash, parts_json FROM prompt_version ORDER BY rowid').all() as {
    hash: string
    parts_json: string
  }[]
}

it('records the latest prompt version when a worker session opens', async () => {
  const { r, chat, fake } = await boot()
  const hashA = r.prompts.version('worker', 'owner/repo')
  const session = await openSession(chat, fake)
  expect(session.spec.instructions).toContain('## Communication\nTeam communication A')
  const [ticket] = r.store.tickets.list()
  expect(
    r.store.db.prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?').get(ticket!.id)?.prompt_version,
  ).toBe(hashA)
  expect(promptRows(r).some(row => row.hash === hashA)).toBe(true)
})

it('injects changed team sections into a running worker session with its next input', async () => {
  const { r, chat, fake } = await boot()
  const session = await openSession(chat, fake)
  const hashA = r.prompts.version('worker', 'owner/repo')
  const rowsBefore = promptRows(r)
  const [ticket] = r.store.tickets.list()
  const workerBefore = r.store.db
    .prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?')
    .get(ticket!.id)?.prompt_version

  teamFile('communication', 'Team communication B')
  expect(r.refreshPrompts()).toBe(1)
  const hashB = r.prompts.version('worker', 'owner/repo')
  expect(hashB).not.toBe(hashA)

  await waitUntil(() => session.sent.some(input => input.mode === 'inject' && input.id === `notice:prompts:${hashB}`))
  const notice = session.sent.find(input => input.mode === 'inject')!
  expect(notice.text).toContain('## Communication\nTeam communication B')
  expect(session.turns).toHaveLength(1)
  expect(promptRows(r).filter(row => row.hash === hashA)).toEqual(rowsBefore.filter(row => row.hash === hashA))
  expect(
    r.store.db.prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?').get(ticket!.id)?.prompt_version,
  ).toBe(workerBefore)

  const sentBefore = session.sent.length
  chat.emit(trigger('2', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => session.sent.length > sentBefore)
  const followUp = session.sent.at(-1)!
  gate.resolve()
  await waitUntil(() => session.turns.length >= 2)
  expect(session.turns[1]!.inputs).toContain(notice.id)
  expect(session.turns[1]!.inputs).toContain(followUp.id)
  expect(session.log.some(event => event.type === 'inputsRead' && event.ids.includes(notice.id))).toBe(true)
  expect(session.turns.some(turn => turn.inputs.length === 1 && turn.inputs[0] === notice.id)).toBe(false)
})

it('sends no notice when nothing changed', async () => {
  const { r, chat, fake } = await boot()
  const session = await openSession(chat, fake)
  expect(r.refreshPrompts()).toBe(0)
  expect(session.sent.filter(input => input.mode === 'inject')).toHaveLength(0)
  expect(r.effects.pending('notice')).toBe(false)
})

it('keeps only the latest notice of a key while delivery waits', async () => {
  const { r, chat, fake } = await boot()
  const session = await openSession(chat, fake)
  teamFile('communication', 'Team communication B')
  r.refreshPrompts()
  teamFile('communication', 'Team communication C')
  r.refreshPrompts()
  expect((r.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'notice'").get() as { n: number }).n).toBe(
    1,
  )
  await r.effects.idle('notice')
  const injects = session.sent.filter(input => input.mode === 'inject')
  expect(injects).toHaveLength(1)
  expect(injects[0]!.text).toContain('Team communication C')
  expect(injects[0]!.text).not.toContain('Team communication B')
})

it('a ticket resumed after it ended gets the changed team sections merged into its first input', async () => {
  const { r, chat, fake } = await boot(({ index }) =>
    index === 0 ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'done' } }] } : {},
  )
  chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => fake.sessions.length === 1 && fake.sessions[0]!.closed)
  await waitUntil(() => r.store.tickets.list().some(ticket => ticket.ended !== undefined))

  teamFile('communication', 'Team communication B')
  r.refreshPrompts()
  const hashB = r.prompts.version('worker', 'owner/repo')
  chat.emit(trigger('2', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => fake.sessions.length === 2)
  expect(fake.sessions[1]!.spec.resume).toBe(fake.sessions[0]!.sessionId)
  const first = fake.sessions[1]!.sent[0]!
  expect(first).toMatchObject({ id: `notice:prompts:${hashB}`, mode: 'inject' })
  expect(first.text).toContain('## Communication\nTeam communication B')
  const [ticket] = r.store.tickets.list()
  expect(
    r.store.db.prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?').get(ticket!.id)?.prompt_version,
  ).toBe(hashB)
})

it("a changed note notices only that repository's open session and changes only its version", async () => {
  const { r, chat, fake } = await boot(undefined, {
    repositories: ['owner/repo', 'other/repo'],
    notes: { 'owner/repo': 'Note A', 'other/repo': 'Other note' },
  })
  chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  chat.emit(
    trigger('2', {
      addressed: 'mention',
      threads: [{ source: 'chat', id: 't2' }],
      channel: { source: 'chat', thread: 't2', address: { message: '2' } },
      meta: { repository: 'other/repo' },
    }),
  )
  await waitUntil(() => fake.sessions.length === 2)
  const owner = fake.sessions.find(session => session.spec.instructions.includes('Note A'))!
  const other = fake.sessions.find(session => session.spec.instructions.includes('Other note'))!
  const vOwner = r.prompts.version('worker', 'owner/repo')
  const vOther = r.prompts.version('worker', 'other/repo')

  noteFile('owner/repo', 'Note B')
  r.prompts.loadNotes(false)
  expect(r.refreshPrompts()).toBe(1)
  const newOwner = r.prompts.version('worker', 'owner/repo')
  expect(newOwner).not.toBe(vOwner)
  expect(r.prompts.version('worker', 'other/repo')).toBe(vOther)

  await waitUntil(() => owner.sent.some(input => input.mode === 'inject' && input.id === `notice:prompts:${newOwner}`))
  const notice = owner.sent.find(input => input.id === `notice:prompts:${newOwner}`)!
  expect(notice.text).toContain('## Environment notes for owner/repo')
  expect(notice.text).toContain('Note B')
  await r.effects.idle('notice')
  expect(other.sent.filter(input => input.mode === 'inject')).toHaveLength(0)
  expect(r.refreshPrompts()).toBe(0)
})

it('a ticket resumed after it ended gets the latest note with its first input', async () => {
  const { r, chat, fake } = await boot(
    ({ index }) =>
      index === 0 ? { tools: [{ name: 'orchestrator_report', args: { state: 'ready', summary: 'done' } }] } : {},
    { notes: { 'owner/repo': 'Note A' } },
  )
  chat.emit(trigger('1', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => fake.sessions.length === 1 && fake.sessions[0]!.closed)
  await waitUntil(() => r.store.tickets.list().some(ticket => ticket.ended !== undefined))

  noteFile('owner/repo', 'Note B')
  r.prompts.loadNotes(false)
  r.refreshPrompts()
  const hashB = r.prompts.version('worker', 'owner/repo')
  chat.emit(trigger('2', { addressed: 'mention', meta: { repository: 'owner/repo' } }))
  await waitUntil(() => fake.sessions.length === 2)
  expect(fake.sessions[1]!.spec.resume).toBe(fake.sessions[0]!.sessionId)
  const first = fake.sessions[1]!.sent[0]!
  expect(first).toMatchObject({ mode: 'inject' })
  expect(first.text).toContain('Note B')
  const [ticket] = r.store.tickets.list()
  expect(
    r.store.db.prepare('SELECT prompt_version FROM worker WHERE ticket_id = ?').get(ticket!.id)?.prompt_version,
  ).toBe(hashB)
})
