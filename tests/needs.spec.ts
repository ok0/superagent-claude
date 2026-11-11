import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { main } from '../src/cli/main.ts'
import { formatNeeds, needsView } from '../src/app/status.ts'
import { databasePath, Store } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { cliEnv, cliIo } from './fixtures/cli.ts'
import { IDS, seedState, TOKEN, writeStateConfig } from './fixtures/state.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'needs-'))
  dirs.push(dir)
  return dir
}

function io(dir: string) {
  return cliIo(dir, cliEnv(dir, { SUPERAGENT_CLAUDE_GITHUB_TOKEN: TOKEN }))
}

describe('needs', () => {
  it('lists only person stage tickets by default, with the question, link and pull request', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir, { only: ['running', 'person', 'ended'] })
    const { io: cli, out } = io(dir)
    expect(await main(['needs', '--config', configPath], cli)).toBe(0)
    const text = out.join('')
    expect(text.startsWith('1 ticket needs you:')).toBe(true)
    expect(text).toContain(`Grant push access [${IDS.person}] person:answer`)
    expect(text).toContain('Question: Can you grant push access to owner/repo?')
    expect(text).toContain('Link: https://github.com/owner/repo/issues/3#issuecomment-1')
    expect(text).toContain('Pull request: https://github.com/owner/repo/pull/12')
    expect(text).not.toContain('Fix the flaky test')
    expect(text).not.toContain('Old cleanup')
    store.close()
  })

  it('--all adds the other open tickets and recently ended ones with their stage', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir, { only: ['running', 'person', 'ended'] })
    const { io: cli, out } = io(dir)
    expect(await main(['needs', '--all', '--config', configPath], cli)).toBe(0)
    const text = out.join('')
    expect(text).toContain(`Fix the flaky test [${IDS.running}] working`)
    expect(text).toContain('Other tickets (2):')
    expect(text).toContain(`Old cleanup [${IDS.ended}] ended:completed`)
    store.close()
  })

  it('--all leaves out a ticket that ended before retention.endedTicketDays', async () => {
    const dir = tempDir()
    const { store, configPath, now } = seedState(dir, { only: ['running', 'person', 'ended'] })
    writeStateConfig(dir, { retention: { endedTicketDays: 1 } })
    const ended = store.tickets.get(IDS.ended)!
    store.tickets.save({ ...ended, ended: { ...ended.ended!, at: new Date(now - 86_400_000 - 60_000).toISOString() } })
    const { io: cli, out } = io(dir)
    expect(await main(['needs', '--all', '--config', configPath], cli)).toBe(0)
    expect(out.join('')).not.toContain('Old cleanup')
    store.close()
  })

  it('prints one line when nothing needs a person', async () => {
    const dir = tempDir()
    const { store, configPath } = seedState(dir, { only: ['running'] })
    const { io: cli, out } = io(dir)
    expect(await main(['needs', '--config', configPath], cli)).toBe(0)
    expect(out.join('')).toBe('Nothing needs you.\n')
    store.close()
  })

  it('labels review and delivery stages', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'state'), { recursive: true })
    const db = databasePath(join(dir, 'state'))
    const store = new Store(db)
    const base = (id: string) => ({
      id,
      title: `Ticket ${id}`,
      decisionId: 'd',
      mandate: {},
      channels: [],
      inputs: [],
      undelivered: [],
      origin: { triggerId: 'tr-none', triggerIds: ['tr-none'] },
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    })
    store.tickets.save({
      ...base('r'.repeat(32)),
      assignments: [
        {
          id: 'as-r',
          state: 'ended',
          createdAt: '2026-03-01T00:00:00.000Z',
          report: { state: 'ready', summary: 'Done it', at: '2026-03-01T00:00:00.000Z' },
        },
      ],
    } as never)
    store.tickets.save({
      ...base('s'.repeat(32)),
      assignments: [],
      delivery: { error: 'x', at: '2026-03-01T00:00:00.000Z' },
    } as never)
    store.close()

    const reader = openReadOnly(db)
    const view = needsView(reader, { all: false, endedWithinMs: 0, now: Date.parse('2026-03-01T00:00:00.000Z') })
    reader.close()
    const byId = Object.fromEntries(view.person.map(item => [item.ticketId, item]))
    expect(byId['r'.repeat(32)]).toMatchObject({ stage: 'person:review', label: 'Report', text: 'Done it' })
    expect(byId['s'.repeat(32)]).toMatchObject({ stage: 'person:delivery', label: 'Delivery error', text: 'x' })
    const text = formatNeeds(view, false)
    expect(text).toContain('Report: Done it')
    expect(text).toContain('Delivery error: x')
  })
})
