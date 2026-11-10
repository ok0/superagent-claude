/** Git workspaces: worktrees on agent branches over a shared clone, reuse of uncommitted files, hooks disabled, and repository access failures reported as failed reports. */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import { RepositoryAccessError, Workspaces, coAuthorTrailers, worktreeName, type RepositoryAccess } from '../src/executor/workspaces.ts'
import { Commands, execProgram } from '../src/infra/commands.ts'
import { waitUntil } from './fixtures/async.ts'
import { accepted } from './fixtures/engine.ts'
import { workerHarness } from './fixtures/executor.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const COMMIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
const idA = 'a'.repeat(32)
const idB = 'b'.repeat(32)
const ticket = (id: string): Ticket => ({ id } as Ticket)
const local = (remote: string, env: Record<string, string> = {}, secrets: string[] = []): RepositoryAccess => ({ remote: () => remote, env: () => env, secrets })
type Sh = (args: string[], cwd: string) => string
function commit(sh: Sh, cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text)
  sh(['add', '-A'], cwd)
  sh([...COMMIT, 'commit', '-m', message], cwd)
}
function spy(dir: string) {
  const calls: { args: readonly string[]; env: Record<string, string> }[] = []
  const commands = new Commands({
    apiProgram: 'gh',
    baseEnv: { PATH: process.env.PATH!, HOME: join(dir, 'home'), LANG: 'C' },
    env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    exec: (p, a, o) => { calls.push({ args: a, env: o.env }); return execProgram(p, a, o) },
  })
  return { commands, calls }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'workspaces-'))
  dirs.push(dir)
  const ENV = { PATH: process.env.PATH!, HOME: join(dir, 'home'), LANG: 'C' }
  mkdirSync(ENV.HOME, { recursive: true })
  const sh = (args: string[], cwd: string): string =>
    execFileSync('git', args, { cwd, env: { ...ENV, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' })
  const origin = join(dir, 'origin.git')
  sh(['init', '--bare', '-b', 'main', origin], dir)
  const seed = join(dir, 'seed')
  sh(['init', '-b', 'main', seed], dir)
  writeFileSync(join(seed, 'README.md'), 'hello')
  mkdirSync(join(seed, '.husky'))
  const marker = join(dir, 'marker')
  writeFileSync(join(seed, '.husky', 'pre-commit'), `#!/bin/sh\ntouch "${marker}"\n`)
  chmodSync(join(seed, '.husky', 'pre-commit'), 0o755)
  sh(['add', '-A'], seed)
  sh([...COMMIT, 'commit', '-m', 'init'], seed)
  sh(['push', origin, 'main'], seed)
  const commands = new Commands({ apiProgram: 'gh', baseEnv: ENV, env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' } })
  const state = join(dir, 'state')
  const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin) })
  return { dir, sh, origin, marker, state, commands, ws }
}

describe('git workspaces', () => {
  it('gives two tickets separate worktrees on agent branches and reuses one with its uncommitted files', async () => {
    const { sh, state, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    const b = await ws.prepare(ticket(idB), 'beta')
    expect(a.cwd).toBe(join(state, 'worktrees', idA))
    expect(b.cwd).toBe(join(state, 'worktrees', idB))
    expect(a.cwd).not.toBe(b.cwd)
    expect(a.branch).toBe('agent/alpha')
    expect(b.branch).toBe('agent/beta')
    expect(sh(['branch', '--show-current'], a.cwd).trim()).toBe('agent/alpha')
    expect(existsSync(join(a.cwd, 'README.md'))).toBe(true)
    expect(existsSync(join(b.cwd, 'README.md'))).toBe(true)

    const notes = join(a.cwd, 'notes.txt')
    writeFileSync(notes, 'draft')
    const again = await ws.prepare(ticket(idA), 'alpha')
    expect({ cwd: again.cwd, branch: again.branch }).toEqual({ cwd: a.cwd, branch: a.branch })
    expect(execFileSync('cat', [notes], { encoding: 'utf8' })).toBe('draft')
    expect(readdirSync(join(state, 'repos'))).toEqual(['owner__repo'])
  })

  it('points core.hooksPath at an empty directory so repository hooks do not run', async () => {
    const { sh, marker, state, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    expect(sh(['config', '--get', 'core.hooksPath'], a.cwd).trim()).toBe(join(state, 'empty-hooks'))
    expect(readdirSync(join(state, 'empty-hooks'))).toEqual([])

    const clone = join(state, 'repos', 'owner__repo')
    const hook = join(clone, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`)
    chmodSync(hook, 0o755)
    sh([...COMMIT, 'commit', '--allow-empty', '-m', 'x'], a.cwd)
    expect(existsSync(marker)).toBe(false)

    sh([...COMMIT, '-c', 'core.hooksPath=.husky', 'commit', '--allow-empty', '-m', 'y'], a.cwd)
    expect(existsSync(marker)).toBe(true)
  })

  it('removes a worktree and can prepare it again on the same branch', async () => {
    const { sh, state, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    const real = realpathSync(a.cwd)
    await ws.remove(idA)
    expect(existsSync(a.cwd)).toBe(false)
    const clone = join(state, 'repos', 'owner__repo')
    expect(sh(['worktree', 'list', '--porcelain'], clone)).not.toContain(real)

    const again = await ws.prepare(ticket(idA), 'alpha')
    expect(again.branch).toBe('agent/alpha')
    expect(existsSync(join(again.cwd, 'README.md'))).toBe(true)
  })

  it('throws RepositoryAccessError with the repository and cause when the clone fails', async () => {
    const { dir, state, commands } = fixture()
    const bad = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(join(dir, 'missing.git')) })
    const error = await bad.prepare(ticket(idA), 'alpha').then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(RepositoryAccessError)
    const access = error as RepositoryAccessError
    expect(access.repository).toBe('owner/repo')
    expect(access.message).toContain('owner/repo')
    expect(access.reason.length).toBeGreaterThan(0)
    expect(existsSync(join(state, 'repos', 'owner__repo'))).toBe(false)
  })

  it('reports failed with the repository and cause when the workspace cannot be prepared', async () => {
    const { dir, state, commands } = fixture()
    const bad = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(join(dir, 'missing.git')) })
    let reason = ''
    try { await bad.prepare(ticket(idA), 'alpha') } catch (e) { reason = (e as RepositoryAccessError).reason }
    const w = workerHarness({ prepare: t => bad.prepare(t, t.id) })
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments.at(-1)?.report?.state === 'failed')
    const summary = w.ticket(id).assignments.at(-1)!.report!.summary
    expect(summary).toContain('owner/repo')
    expect(summary).toContain(reason.slice(0, 40))
    w.close()
  })

  it('passes the access env only to clone and fetch and keeps the token out of git config and remote URLs', async () => {
    const { dir, sh, origin, state } = fixture()
    const SECRET = 'ghp_TESTSECRET0123456789'
    const B64 = Buffer.from('x-access-token:' + SECRET).toString('base64')
    const AUTH = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64 }
    const calls: { args: readonly string[]; env: Record<string, string> }[] = []
    const commands = new Commands({
      apiProgram: 'gh',
      baseEnv: { PATH: process.env.PATH!, HOME: join(dir, 'home'), LANG: 'C' },
      env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
      exec: (p, a, o) => { calls.push({ args: a, env: o.env }); return execProgram(p, a, o) },
    })
    const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin, AUTH, [SECRET, B64]) })
    const a = await ws.prepare(ticket(idA), 'alpha')
    const b = await ws.prepare(ticket(idB), 'beta')
    expect(calls.filter(c => c.env.GIT_CONFIG_VALUE_0 !== undefined).map(c => c.args[2])).toEqual(['clone', 'fetch'])
    expect(calls.filter(c => c.env.GIT_CONFIG_VALUE_0 === undefined).every(c => c.env.GIT_CONFIG_COUNT === undefined)).toBe(true)
    const clone = join(state, 'repos', 'owner__repo')
    const texts = [
      readFileSync(join(clone, '.git', 'config'), 'utf8'),
      sh(['config', '--list', '--show-origin'], a.cwd),
      sh(['config', '--list', '--show-origin'], b.cwd),
      sh(['remote', 'get-url', 'origin'], a.cwd),
    ]
    for (const text of texts) {
      expect(text).not.toContain(SECRET)
      expect(text).not.toContain(B64)
    }
  })

  it('masks the token in the access error and the failed report', async () => {
    const { dir, state, commands } = fixture()
    const SECRET = 'ghp_TESTSECRET0123456789'
    const B64 = Buffer.from('x-access-token:' + SECRET).toString('base64')
    const AUTH = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64 }
    const bad = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(join(dir, 'missing-' + SECRET + '.git'), AUTH, [SECRET, B64]) })
    const error = await bad.prepare(ticket(idA), 'alpha').then(() => undefined, (e: unknown) => e) as RepositoryAccessError
    expect(error).toBeInstanceOf(RepositoryAccessError)
    expect(error.repository).toBe('owner/repo')
    expect(error.reason).toContain('***')
    expect(error.message).not.toContain(SECRET)
    expect(error.reason).not.toContain(SECRET)
    const w = workerHarness({ prepare: t => bad.prepare(t, t.id) })
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments.at(-1)?.report?.state === 'failed')
    const summary = w.ticket(id).assignments.at(-1)!.report!.summary
    expect(summary).toContain('owner/repo')
    expect(summary).not.toContain(SECRET)
    w.close()
  })

  it('pushes the agent branch without force and reports the base and unpushed count', async () => {
    const { sh, origin, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    const first = await ws.push(ticket(idA), {})
    expect({ branch: first.branch, base: first.base, pushed: first.pushed, rewritten: first.rewritten, uncommitted: first.uncommitted }).toEqual({ branch: 'agent/alpha', base: 'main', pushed: 1, rewritten: 0, uncommitted: false })
    expect(sh(['rev-parse', 'refs/heads/agent/alpha'], origin).trim()).toBe(sh(['rev-parse', 'HEAD'], a.cwd).trim())
    expect((await ws.push(ticket(idA), {})).pushed).toBe(0)
  })

  it('adds co-author trailers only to unpushed commits and keeps pushed SHAs', async () => {
    const { dir, sh, origin, state } = fixture()
    const { commands, calls } = spy(dir)
    const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin) })
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    await ws.push(ticket(idA), {})
    const sha1 = sh(['rev-parse', 'HEAD'], a.cwd).trim()
    commit(sh, a.cwd, 'two.txt', '2', 'c2')
    commit(sh, a.cwd, 'three.txt', '3', 'c3')
    const result = await ws.push(ticket(idA), { coAuthors: ['Ann Lee <ann@example.com>'] })
    expect(result.rewritten).toBe(2)
    expect(result.pushed).toBe(2)
    expect(sh(['rev-parse', 'agent/alpha~2'], origin).trim()).toBe(sha1)
    expect(sh(['log', '-1', '--format=%B', 'agent/alpha~2'], origin)).not.toContain('Co-authored-by')
    for (const ref of ['agent/alpha~1', 'agent/alpha']) {
      const body = sh(['log', '-1', '--format=%B', ref], origin)
      expect(body.split('Co-authored-by: Ann Lee <ann@example.com>').length - 1).toBe(1)
    }
    for (const call of calls.filter(c => c.args.includes('push'))) {
      expect(call.args.some(arg => ['--force', '-f', '--force-with-lease'].includes(arg) || arg.startsWith('+'))).toBe(false)
    }
  })

  it('refuses to publish without commits and rejects a malformed co-author before any git call', async () => {
    const { dir, state, origin } = fixture()
    const { commands, calls } = spy(dir)
    const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin) })
    await ws.prepare(ticket(idA), 'alpha')
    await expect(ws.push(ticket(idA), {})).rejects.toThrow(/no commits to publish/)
    const before = calls.length
    await expect(ws.push(ticket(idA), { coAuthors: ['ann'] })).rejects.toThrow(/Name <email>/)
    expect(calls.length).toBe(before)
  })

  it('passes the access env to the push', async () => {
    const { dir, sh, origin, state } = fixture()
    const SECRET = 'ghp_TESTSECRET0123456789'
    const B64 = Buffer.from('x-access-token:' + SECRET).toString('base64')
    const AUTH = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraheader', GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64 }
    const { commands, calls } = spy(dir)
    const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin, AUTH, [SECRET, B64]) })
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    await ws.push(ticket(idA), {})
    const push = calls.find(c => c.args.includes('push'))
    expect(push?.env.GIT_CONFIG_VALUE_0).toBeDefined()
  })

  it('coAuthorTrailers appends to an existing trailer block and skips present ones', () => {
    expect(coAuthorTrailers('Fix\n\nSigned-off-by: A <a@x.io>\n', ['B <b@x.io>'])).toBe('Fix\n\nSigned-off-by: A <a@x.io>\nCo-authored-by: B <b@x.io>\n')
    const message = 'Fix\n\nCo-authored-by: B <b@x.io>\n'
    expect(coAuthorTrailers(message, ['B <b@x.io>'])).toBe(message)
  })

  it('worktreeName uses the execution name with the id prefix, else the id', () => {
    expect(worktreeName({ id: 'c'.repeat(32) })).toBe('c'.repeat(32))
    expect(worktreeName({ id: 'c'.repeat(32), execution: { name: 'Fix Login!', directory: '', assignment: '' } })).toBe('fix-login-cccccccccccc')
  })
})
