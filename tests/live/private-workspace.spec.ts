/** Live private repository worktree preparation with the host token, gated by SUPERAGENT_CLAUDE_LIVE=1 and SUPERAGENT_CLAUDE_GITHUB_TOKEN; never prints the token. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertAllowedRepo } from './guard.ts'
import { liveEnabled, liveTarget } from './target.ts'
import type { Ticket } from '../../src/core/index.ts'
import { repositoryAccess } from '../../src/app/sources.ts'
import { RepositoryAccessError, Workspaces } from '../../src/executor/workspaces.ts'
import { Commands } from '../../src/infra/commands.ts'

const TARGET = liveTarget()
const LIVE = liveEnabled()
const TOKEN = process.env.SUPERAGENT_CLAUDE_GITHUB_TOKEN?.trim()
const REPO = TARGET ? assertAllowedRepo(TARGET.repo) : ''

describe.skipIf(!LIVE || !TOKEN)('live private workspace', () => {
  it('prepares a worktree of the private repository with the host token and keeps the token out of git config', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sac-private-'))
    try {
      const home = join(dir, 'home')
      mkdirSync(home, { recursive: true })
      const commands = new Commands({ apiProgram: 'gh', baseEnv: { PATH: process.env.PATH!, HOME: home, LANG: 'C' }, env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })
      const access = repositoryAccess(process.env)
      const ticket = { id: 'd'.repeat(32) } as Ticket

      const plain = new Workspaces({ stateDir: join(dir, 'plain'), commands, repositoryOf: () => REPO, access: { ...access, env: () => ({}) } })
      const unauth = await plain.prepare(ticket, 'live-private').then(() => 'allowed', e => e instanceof RepositoryAccessError && !e.message.includes(TOKEN!) ? 'refused' : 'other')
      expect(unauth).not.toBe('other')

      const state = join(dir, 'state')
      const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => REPO, access })
      const w = await ws.prepare(ticket, 'live-private')
      expect(w.cwd).toBe(join(state, 'worktrees', ticket.id))
      expect(w.branch).toBe('agent/live-private')
      expect(existsSync(join(w.cwd, '.git'))).toBe(true)
      expect((await commands.git(['branch', '--show-current'], w.cwd)).trim()).toBe('agent/live-private')

      const texts = [
        readFileSync(join(ws.clonePath(REPO), '.git', 'config'), 'utf8'),
        await commands.git(['config', '--list', '--show-origin'], w.cwd),
        await commands.git(['remote', 'get-url', 'origin'], w.cwd),
      ]
      const encoded = access.secrets[1]!
      for (const text of texts) {
        expect(text).not.toContain(TOKEN!)
        expect(text).not.toContain(encoded)
      }
      console.log(`[M12-PRIVATE] repository=${REPO} branch=${w.branch} worktree=<stateDir>/worktrees/${ticket.id} tokenInConfig=false unauthenticated=${unauth}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
