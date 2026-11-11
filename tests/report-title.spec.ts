/** A worker's report title renames its ticket in status and needs; omitting it keeps the title (ADR-25). */
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mention, startRuntime, type Host } from './fixtures/host.ts'
import { databasePath } from '../src/app/store.ts'
import { openReadOnly } from '../src/app/store-read.ts'
import { formatNeeds, formatStatus, needsView, statusView } from '../src/app/status.ts'

let host: Host | undefined

afterEach(async () => {
  await host?.stop()
  host = undefined
})

function outputs(h: Host): { status: string; needs: string } {
  const reader = openReadOnly(databasePath(join(h.dir, 'state')))
  try {
    const now = Date.now()
    return {
      status: formatStatus(statusView(reader, { daemon: true, now })),
      needs: formatNeeds(needsView(reader, { all: true, endedWithinMs: 0, now }), true),
    }
  } finally {
    reader.close()
  }
}

describe('report title', () => {
  it('a report with a title renames the ticket in status and needs, and a report without one keeps it', async () => {
    host = await startRuntime()
    const { ticket } = await host.acceptedTicket(mention('1'))
    const old = ticket.title
    await host.workerTool(ticket.id, 'orchestrator_report', {
      state: 'progress',
      summary: 'Changed plan',
      title: 'Add WELCOME.md instead of GREETING.md',
    })
    await host.idle()
    const renamed = outputs(host)
    expect(renamed.status).toContain('Add WELCOME.md instead of GREETING.md')
    expect(renamed.needs).toContain('Add WELCOME.md instead of GREETING.md')
    if (old !== 'Add WELCOME.md instead of GREETING.md') {
      for (const text of [renamed.status, renamed.needs]) {
        const line = text.split('\n').find(item => item.includes(ticket.id))
        expect(line?.includes(old) ?? false).toBe(false)
      }
    }
    await host.workerTool(ticket.id, 'orchestrator_report', { state: 'progress', summary: 'Still working' })
    await host.idle()
    const kept = outputs(host)
    expect(kept.status).toContain('Add WELCOME.md instead of GREETING.md')
    expect(kept.needs).toContain('Add WELCOME.md instead of GREETING.md')
  })
})
