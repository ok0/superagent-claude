/**
 * Git workspaces: worktrees on agent branches over a shared clone, reuse of uncommitted files, hooks disabled, and
 * repository access failures reported as failed reports.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/index.ts'
import {
  PUSH_BACKOFF_MS,
  RepositoryAccessError,
  Workspaces,
  accessStatus,
  coAuthorTrailers,
  pushFailure,
  worktreeName,
  type RepositoryAccess,
} from '../src/executor/workspaces.ts'
import { CliError, Commands, commandError, execProgram } from '../src/infra/commands.ts'
import { isAiAttributionLine } from '../src/infra/text.ts'
import { waitUntil } from './fixtures/async.ts'
import { accepted } from './fixtures/engine.ts'
import { workerHarness } from './fixtures/executor.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const PRODUCT = ['Claude', 'Code'].join(' ')
const AI = 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'
const GEN = '🤖 Generated with [' + PRODUCT + '](https://claude.com/claude-code)'
const COMMIT = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']
const idA = 'a'.repeat(32)
const idB = 'b'.repeat(32)
const ticket = (id: string): Ticket => ({ id }) as Ticket
const local = (remote: string, env: Record<string, string> = {}, secrets: string[] = []): RepositoryAccess => ({
  remote: () => remote,
  env: () => env,
  secrets,
})
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
    exec: (p, a, o) => {
      calls.push({ args: a, env: o.env })
      return execProgram(p, a, o)
    },
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
  const commands = new Commands({
    apiProgram: 'gh',
    baseEnv: ENV,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
  })
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
    const bad = new Workspaces({
      stateDir: state,
      commands,
      repositoryOf: () => 'owner/repo',
      access: local(join(dir, 'missing.git')),
    })
    const error = await bad.prepare(ticket(idA), 'alpha').then(
      () => undefined,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RepositoryAccessError)
    const access = error as RepositoryAccessError
    expect(access.repository).toBe('owner/repo')
    expect(access.message).toContain('owner/repo')
    expect(access.reason.length).toBeGreaterThan(0)
    expect(existsSync(join(state, 'repos', 'owner__repo'))).toBe(false)
  })

  it('reports failed with the repository and cause when the workspace cannot be prepared', async () => {
    const { dir, state, commands } = fixture()
    const bad = new Workspaces({
      stateDir: state,
      commands,
      repositoryOf: () => 'owner/repo',
      access: local(join(dir, 'missing.git')),
    })
    let reason = ''
    try {
      await bad.prepare(ticket(idA), 'alpha')
    } catch (e) {
      reason = (e as RepositoryAccessError).reason
    }
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
    const AUTH = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64,
    }
    const calls: { args: readonly string[]; env: Record<string, string> }[] = []
    const commands = new Commands({
      apiProgram: 'gh',
      baseEnv: { PATH: process.env.PATH!, HOME: join(dir, 'home'), LANG: 'C' },
      env: { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
      exec: (p, a, o) => {
        calls.push({ args: a, env: o.env })
        return execProgram(p, a, o)
      },
    })
    const ws = new Workspaces({
      stateDir: state,
      commands,
      repositoryOf: () => 'owner/repo',
      access: local(origin, AUTH, [SECRET, B64]),
    })
    const a = await ws.prepare(ticket(idA), 'alpha')
    const b = await ws.prepare(ticket(idB), 'beta')
    expect(calls.filter(c => c.env.GIT_CONFIG_VALUE_0 !== undefined).map(c => c.args[2])).toEqual(['clone', 'fetch'])
    expect(
      calls.filter(c => c.env.GIT_CONFIG_VALUE_0 === undefined).every(c => c.env.GIT_CONFIG_COUNT === undefined),
    ).toBe(true)
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
    const AUTH = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64,
    }
    const bad = new Workspaces({
      stateDir: state,
      commands,
      repositoryOf: () => 'owner/repo',
      access: local(join(dir, 'missing-' + SECRET + '.git'), AUTH, [SECRET, B64]),
    })
    const error = (await bad.prepare(ticket(idA), 'alpha').then(
      () => undefined,
      (e: unknown) => e,
    )) as RepositoryAccessError
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

  it('a clone 403 is a repository access error with the repository and status and without the token', async () => {
    const { state, commands } = fixture()
    const SECRET = 'SECRET'
    const bad = new Workspaces({
      stateDir: state,
      commands: {
        git: async args => {
          if (args.includes('clone'))
            throw commandError(
              Object.assign(new Error('x'), {
                stderr:
                  "fatal: unable to access 'https://SECRET@host/acme/widgets.git/': The requested URL returned error: 403",
                code: 128,
              }),
              'git',
            )
          return ''
        },
      },
      repositoryOf: () => 'acme/widgets',
      access: local('https://host/acme/widgets.git', {}, [SECRET]),
    })
    const error = (await bad.prepare(ticket(idA), 'alpha').then(
      () => undefined,
      (e: unknown) => e,
    )) as RepositoryAccessError
    expect(error).toBeInstanceOf(RepositoryAccessError)
    expect(error.status).toBe(403)
    expect(error.repository).toBe('acme/widgets')
    expect(error.message).toContain('acme/widgets')
    expect(error.message).toContain('(HTTP 403)')
    expect(error.message).not.toContain(SECRET)
    const w = workerHarness({ prepare: t => bad.prepare(t, t.id) })
    const id = accepted(w, '1').ticketId!
    await waitUntil(() => w.ticket(id).assignments.at(-1)?.report?.state === 'failed')
    const summary = w.ticket(id).assignments.at(-1)!.report!.summary
    expect(summary).toContain('acme/widgets')
    expect(summary).toContain('HTTP 403')
    expect(summary).not.toContain(SECRET)
    w.close()
  })

  it('accessStatus reads the API code and the printed status', () => {
    expect(accessStatus(new CliError('x', 404))).toBe(404)
    expect(accessStatus(new Error('gh: Request failed (HTTP 403)'))).toBe(403)
    expect(accessStatus(new Error('The requested URL returned error: 401'))).toBe(401)
    expect(accessStatus(new Error('disk full'))).toBeUndefined()
  })

  it('pushes the agent branch without force and reports the base and unpushed count', async () => {
    const { sh, origin, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    const first = await ws.push(ticket(idA), {})
    expect({
      branch: first.branch,
      base: first.base,
      pushed: first.pushed,
      rewritten: first.rewritten,
      uncommitted: first.uncommitted,
    }).toEqual({ branch: 'agent/alpha', base: 'main', pushed: 1, rewritten: 0, uncommitted: false })
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
      expect(call.args.some(arg => ['--force', '-f', '--force-with-lease'].includes(arg) || arg.startsWith('+'))).toBe(
        false,
      )
    }
  })

  it('strips AI attribution from unpushed commits, keeps human co-authors and pushed SHAs, and never force-pushes', async () => {
    const { dir, sh, origin, state } = fixture()
    const { commands, calls } = spy(dir)
    const ws = new Workspaces({ stateDir: state, commands, repositoryOf: () => 'owner/repo', access: local(origin) })
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    await ws.push(ticket(idA), {})
    const sha1 = sh(['rev-parse', 'HEAD'], a.cwd).trim()
    commit(sh, a.cwd, 'two.txt', '2', 'feat: two\n\nBody.\n\n' + AI + '\nCo-authored-by: Bea Kim <bea@example.com>')
    commit(sh, a.cwd, 'three.txt', '3', 'feat: three\n\n' + GEN)
    const result = await ws.push(ticket(idA), { coAuthors: ['Ann Lee <ann@example.com>'] })
    expect(result.rewritten).toBe(2)
    expect(result.pushed).toBe(2)
    expect(sh(['rev-parse', 'agent/alpha~2'], origin).trim()).toBe(sha1)
    for (const ref of ['agent/alpha~1', 'agent/alpha']) {
      const body = sh(['log', '-1', '--format=%B', ref], origin)
      expect(body.split('\n').some(isAiAttributionLine)).toBe(false)
      expect(body.split('Co-authored-by: Ann Lee <ann@example.com>').length - 1).toBe(1)
    }
    expect(sh(['log', '-1', '--format=%B', 'agent/alpha~1'], origin)).toContain(
      'Co-authored-by: Bea Kim <bea@example.com>',
    )
    expect(sh(['log', '-1', '--format=%B', 'agent/alpha~1'], origin)).toContain('Body.')
    for (const call of calls.filter(c => c.args.includes('push'))) {
      expect(call.args.some(arg => ['--force', '-f', '--force-with-lease'].includes(arg) || arg.startsWith('+'))).toBe(
        false,
      )
    }
  })

  it('keeps SHAs of commits without attribution when no co-authors are given', async () => {
    const { sh, origin, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    commit(sh, a.cwd, 'two.txt', '2', 'c2')
    const head = sh(['rev-parse', 'HEAD'], a.cwd).trim()
    const parent = sh(['rev-parse', 'HEAD~1'], a.cwd).trim()
    const result = await ws.push(ticket(idA), {})
    expect(result.rewritten).toBe(0)
    expect(sh(['rev-parse', 'agent/alpha'], origin).trim()).toBe(head)
    expect(sh(['rev-parse', 'agent/alpha~1'], origin).trim()).toBe(parent)
  })

  it('strips attribution without co-authors', async () => {
    const { sh, origin, ws } = fixture()
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'fix: one\n\nWhy.\n\n' + AI)
    const result = await ws.push(ticket(idA), {})
    expect(result.rewritten).toBe(1)
    expect(sh(['log', '-1', '--format=%B', 'agent/alpha'], origin).trim()).toBe('fix: one\n\nWhy.')
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
    const AUTH = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraheader',
      GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + B64,
    }
    const { commands, calls } = spy(dir)
    const ws = new Workspaces({
      stateDir: state,
      commands,
      repositoryOf: () => 'owner/repo',
      access: local(origin, AUTH, [SECRET, B64]),
    })
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    await ws.push(ticket(idA), {})
    const push = calls.find(c => c.args.includes('push'))
    expect(push?.env.GIT_CONFIG_VALUE_0).toBeDefined()
  })

  it('coAuthorTrailers appends to an existing trailer block and skips present ones', () => {
    expect(coAuthorTrailers('Fix\n\nSigned-off-by: A <a@x.io>\n', ['B <b@x.io>'])).toBe(
      'Fix\n\nSigned-off-by: A <a@x.io>\nCo-authored-by: B <b@x.io>\n',
    )
    const message = 'Fix\n\nCo-authored-by: B <b@x.io>\n'
    expect(coAuthorTrailers(message, ['B <b@x.io>'])).toBe(message)
  })

  it('worktreeName uses the execution name with the id prefix, else the id', () => {
    expect(worktreeName({ id: 'c'.repeat(32) })).toBe('c'.repeat(32))
    expect(worktreeName({ id: 'c'.repeat(32), execution: { name: 'Fix Login!', directory: '', assignment: '' } })).toBe(
      'fix-login-cccccccccccc',
    )
  })
})

function flaky(commands: Pick<Commands, 'git'>, stderrs: string[]) {
  const count = { pushes: 0 }
  const git: Pick<Commands, 'git'>['git'] = async (args, cwd, extra) => {
    if (args.includes('push')) {
      count.pushes++
      const stderr = stderrs.shift()
      if (typeof stderr === 'string') throw commandError(Object.assign(new Error('x'), { stderr, code: 1 }), 'git')
    }
    return commands.git(args, cwd, extra)
  }
  return { commands: { git }, count }
}

const TRANSIENT =
  " ! [remote rejected] HEAD -> agent/alpha (fatal error in commit_refs)\nerror: failed to push some refs to 'https://host/owner/repo.git'"
const NFF = ' ! [rejected]        HEAD -> agent/alpha (non-fast-forward)\nerror: failed to push some refs'
const DENIED =
  "remote: Permission to owner/repo.git denied to ok0-worker.\nfatal: unable to access 'https://host/owner/repo.git/': The requested URL returned error: 403"
const MISSING = "remote: Repository not found.\nfatal: repository 'https://host/owner/repo.git/' not found"

describe('push retries', () => {
  async function pushWith(stderrs: string[]) {
    const { sh, commands, state, origin } = fixture()
    const f = flaky(commands, stderrs)
    const delays: number[] = []
    const ws = new Workspaces({
      stateDir: state,
      commands: f.commands,
      repositoryOf: () => 'owner/repo',
      access: local(origin),
      sleep: async ms => {
        delays.push(ms)
      },
    })
    const a = await ws.prepare(ticket(idA), 'alpha')
    commit(sh, a.cwd, 'one.txt', '1', 'c1')
    return { sh, origin, a, f, delays, ws }
  }

  it('retries a transient push failure and then pushes', async () => {
    const { sh, origin, a, f, delays, ws } = await pushWith([TRANSIENT])
    const result = await ws.push(ticket(idA), {})
    expect(result.pushed).toBe(1)
    expect(f.count.pushes).toBe(2)
    expect(delays).toEqual([2000])
    expect(sh(['rev-parse', 'refs/heads/agent/alpha'], origin).trim()).toBe(sh(['rev-parse', 'HEAD'], a.cwd).trim())
  })

  it('returns an error after three transient push failures', async () => {
    const { f, delays, ws } = await pushWith([TRANSIENT, TRANSIENT, TRANSIENT])
    const error = (await ws.push(ticket(idA), {}).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(RepositoryAccessError)
    expect(error.message).toContain('fatal error in commit_refs')
    expect(error.message).toContain('3 attempts')
    expect(f.count.pushes).toBe(3)
    expect(delays).toEqual([...PUSH_BACKOFF_MS])
  })

  it('a non-fast-forward push fails at once', async () => {
    const { f, delays, ws } = await pushWith([NFF])
    await expect(ws.push(ticket(idA), {})).rejects.toThrow(/rejected without force/)
    expect(f.count.pushes).toBe(1)
    expect(delays).toEqual([])
  })

  it('a 403 push is a repository access error at once', async () => {
    const { f, delays, ws } = await pushWith([DENIED])
    const error = (await ws.push(ticket(idA), {}).then(
      () => undefined,
      (e: unknown) => e,
    )) as RepositoryAccessError
    expect(error).toBeInstanceOf(RepositoryAccessError)
    expect(error.status).toBe(403)
    expect(f.count.pushes).toBe(1)
    expect(delays).toEqual([])
  })

  it('a missing repository is a repository access error at once', async () => {
    const { f, ws } = await pushWith([MISSING])
    const error = (await ws.push(ticket(idA), {}).then(
      () => undefined,
      (e: unknown) => e,
    )) as RepositoryAccessError
    expect(error).toBeInstanceOf(RepositoryAccessError)
    expect(error.status).toBe(404)
    expect(f.count.pushes).toBe(1)
  })

  it.each([
    [TRANSIENT, undefined, 'transient'],
    [NFF, undefined, 'rejected'],
    ['x', 401, 'access'],
    [DENIED, 403, 'access'],
    ['fatal: Authentication failed for https://host/owner/repo.git', undefined, 'access'],
    ['The requested URL returned error: 500', 500, 'transient'],
  ])('pushFailure classifies push errors %# as %s', (message, status, kind) => {
    expect(pushFailure(message, status).kind).toBe(kind)
  })
})
