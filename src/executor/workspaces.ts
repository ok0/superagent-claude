/**
 * Worker workspaces: git worktrees on agent branches over one shared clone per repository,
 * and scratch directories for fake runs.
 * Clone and fetch get the injected access env (authentication), and errors mask its secrets.
 * Publishing pushes an agent branch without force, adding co-author trailers only to commits not yet pushed.
 * Access errors carry the HTTP status when one is known. A transient push failure is retried up to 3 times (2 s, 5 s).
 * A worktree starts from the configured remote branch, the branch choice is fixed per ticket in a host file outside the worktree, and a missing configured branch stops prepare or push with `WorkspaceBlocked`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { Ticket } from '../core/index.ts'
import { CliError, type CommandLimits, type Commands } from '../infra/commands.ts'
import { stripAiAttribution } from '../infra/text.ts'
import {
  GIT_INSPECT_LIMITS,
  GIT_READ_OPTIONS,
  type GitInspectRequest,
  gitInspectArgv,
  truncateOutput,
} from './git-inspect.ts'
import { WorkspaceBlocked, type Workspace } from './worker-executor.ts'

export { WorkspaceBlocked }

export class RepositoryAccessError extends Error {
  readonly repository: string
  readonly reason: string
  readonly status: number | undefined
  constructor(repository: string, reason: string, status?: number) {
    super(`Repository ${repository} could not be accessed${status ? ` (HTTP ${status})` : ''}: ${reason}`)
    this.name = 'RepositoryAccessError'
    this.repository = repository
    this.reason = reason
    this.status = status
  }
}

/** The API error code, or the HTTP status printed by git or the API program. */
export function accessStatus(error: unknown): number | undefined {
  if (error instanceof CliError && error.code !== undefined && error.code >= 100 && error.code <= 599) return error.code
  const found = /\b(?:HTTP|returned error:)\s*(\d{3})\b/i.exec(error instanceof Error ? error.message : String(error))
  return found ? Number(found[1]) : undefined
}

export const PUSH_ATTEMPTS = 3
export const PUSH_BACKOFF_MS: readonly number[] = [2_000, 5_000]

export type PushFailure = { kind: 'rejected' } | { kind: 'access'; status: number | undefined } | { kind: 'transient' }

/** Anything that is not a non-fast-forward or an access failure is transient. */
export function pushFailure(message: string, status: number | undefined): PushFailure {
  if (/non-fast-forward|fetch first|\[rejected\]|updates were rejected/i.test(message)) return { kind: 'rejected' }
  if (status === 401 || status === 403 || status === 404) return { kind: 'access', status }
  if (/repository not found|repository '[^']*' not found/i.test(message)) return { kind: 'access', status: 404 }
  if (/permission to \S+ denied|permission denied|access denied/i.test(message)) return { kind: 'access', status: 403 }
  if (/authentication failed|could not read username|invalid username or password/i.test(message))
    return { kind: 'access', status: 401 }
  return { kind: 'transient' }
}

export interface DiffStat {
  base: string
  files: number
  changedLines: number
}

export interface DiffText {
  text: string
  truncated: boolean
}

export interface BranchConfig {
  branchFrom?: string
  pullRequestTo?: string
}

export interface WorkspaceProvider {
  prepare(ticket: Ticket, name: string, branches?: BranchConfig): Promise<Workspace>
  remove(ticketId: string): Promise<void>
  history(cwd: string): Promise<string>
  push(ticket: Ticket, options: PushOptions): Promise<PushResult>
  head(cwd: string): Promise<string>
  diffStat(cwd: string, base?: string): Promise<DiffStat>
  diffText(cwd: string, base: string, maxChars: number): Promise<DiffText>
  inspect(cwd: string, request: GitInspectRequest): Promise<string>
}

const SHA = /^[0-9a-f]{7,64}$/
const NO_WORKTREE = 'This session has no git worktree'
const DIFF = ['--no-ext-diff', '--no-textconv', '--no-color']

export const CO_AUTHOR = /^[^<>\r\n]+ <[^<>\s@]+@[^<>\s]+>$/

export interface PushOptions {
  coAuthors?: readonly string[]
}
export interface PushResult {
  repository: string
  branch: string
  base: string
  head: string
  pushed: number
  rewritten: number
  uncommitted: boolean
}

export function coAuthorTrailers(message: string, coAuthors: readonly string[]): string {
  const lines = new Set(message.split(/\r?\n/).map(line => line.trim().toLowerCase()))
  const missing = coAuthors.filter(author => !lines.has(('co-authored-by: ' + author).toLowerCase()))
  if (!missing.length) return message
  const text = message.replace(/\s+$/, '')
  const paragraphs = text.split(/\n\s*\n/)
  const last = paragraphs[paragraphs.length - 1] ?? ''
  const trailerBlock = paragraphs.length > 1 && last.split('\n').every(line => /^[A-Za-z0-9-]+: \S/.test(line))
  return text + (trailerBlock ? '\n' : '\n\n') + missing.map(author => 'Co-authored-by: ' + author).join('\n') + '\n'
}

export function worktreeName(ticket: Pick<Ticket, 'id' | 'execution'>): string {
  const slug = (ticket.execution?.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 40)
  return slug ? `${slug}-${ticket.id.slice(0, 12)}` : ticket.id
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Provided by the Source assembly point so the executor never names the hosting service.
 * `env` authenticates only the clone and fetch calls; `secrets` are masked in errors.
 */
export interface RepositoryAccess {
  remote(repository: string): string
  env(repository: string): Record<string, string>
  secrets: readonly string[]
}

export interface WorkspacesOptions {
  stateDir: string
  commands: Pick<Commands, 'git'>
  repositoryOf(ticket: Ticket): string
  access: RepositoryAccess
  /** Waits between push attempts; tests pass a fake clock. */
  sleep?: (ms: number) => Promise<void>
}

export class Workspaces implements WorkspaceProvider {
  readonly hooks: string
  private readonly stateDir: string
  private readonly commands: Pick<Commands, 'git'>
  private readonly repositoryOf: (ticket: Ticket) => string
  private readonly access: RepositoryAccess
  private readonly sleep: (ms: number) => Promise<void>
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(options: WorkspacesOptions) {
    this.stateDir = options.stateDir
    this.commands = options.commands
    this.repositoryOf = options.repositoryOf
    this.access = options.access
    this.sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
    this.hooks = join(options.stateDir, 'empty-hooks')
  }

  private git(
    args: string[],
    cwd: string,
    extra: Record<string, string> = {},
    limits: CommandLimits = {},
  ): Promise<string> {
    return this.commands.git(['-c', `core.hooksPath=${this.hooks}`, ...args], cwd, extra, limits)
  }

  private redact(text: string): string {
    for (const secret of this.access.secrets) if (secret) text = text.split(secret).join('***')
    return text
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(key) ?? Promise.resolve()).then(run, run)
    this.chains.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }

  worktreePath(ticketId: string): string {
    return join(this.stateDir, 'worktrees', ticketId)
  }

  clonePath(repository: string): string {
    return join(this.stateDir, 'repos', repository.replace('/', '__'))
  }

  private branchesPath(ticketId: string): string {
    return join(this.stateDir, 'branches', ticketId + '.json')
  }

  private fixedBranches(ticketId: string): { from?: string; to?: string } | undefined {
    const path = this.branchesPath(ticketId)
    if (!existsSync(path)) return undefined
    const record: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof record !== 'object' || record === null || Array.isArray(record))
      throw new Error(`The branch record of ticket ${ticketId} is unreadable`)
    const { from, to } = record as { from?: unknown; to?: unknown }
    if ((from !== undefined && typeof from !== 'string') || (to !== undefined && typeof to !== 'string'))
      throw new Error(`The branch record of ticket ${ticketId} is unreadable`)
    return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) }
  }

  private remoteHas(clone: string, name: string): Promise<boolean> {
    return this.git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + name], clone).then(
      () => true,
      () => false,
    )
  }

  async prepare(ticket: Ticket, name: string, branches: BranchConfig = {}): Promise<Workspace> {
    if (!NAME.test(name) || name.includes('..') || name.endsWith('.lock'))
      throw new Error('Invalid worktree name: ' + name)
    const repository = this.repositoryOf(ticket)
    if (!REPOSITORY.test(repository)) throw new RepositoryAccessError(repository, 'not an owner/name repository')
    const cwd = this.worktreePath(ticket.id)
    const branch = 'agent/' + name
    const hooks = this.hooks
    mkdirSync(hooks, { recursive: true })
    return this.serial(repository, async () => {
      const clone = this.clonePath(repository)
      if (existsSync(join(cwd, '.git'))) {
        if (existsSync(join(clone, '.git'))) await this.git(['config', 'core.hooksPath', hooks], clone)
        const current = (await this.git(['branch', '--show-current'], cwd).catch(() => '')).trim()
        return { repository, cwd, branch: current || branch }
      }
      const base = await this.clone(repository)
      mkdirSync(dirname(cwd), { recursive: true })
      await this.git(['worktree', 'prune'], base)
      const stored = this.fixedBranches(ticket.id)
      const fixed: { from?: string; to?: string } = stored ?? {
        ...(branches.branchFrom ? { from: branches.branchFrom } : {}),
        ...(branches.pullRequestTo ? { to: branches.pullRequestTo } : {}),
      }
      const names = [...new Set([fixed.from, fixed.to].filter((name): name is string => name !== undefined))]
      const missing: string[] = []
      for (const name of names) if (!(await this.remoteHas(base, name))) missing.push(name)
      if (missing.length)
        throw new WorkspaceBlocked(
          `${repository} has no branch ${missing.join(', ')}, so no workspace was made. A person must create the branch or change branchFrom or pullRequestTo for ${repository} in the config.`,
        )
      const exists = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], base).then(
        () => true,
        () => false,
      )
      await this.git(
        exists
          ? ['worktree', 'add', cwd, branch]
          : ['worktree', 'add', '--no-track', '-b', branch, cwd, fixed.from ? 'origin/' + fixed.from : 'origin/HEAD'],
        base,
      )
      if (stored === undefined) {
        const path = this.branchesPath(ticket.id)
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
        writeFileSync(path, JSON.stringify(fixed) + '\n', { mode: 0o600 })
      }
      return { repository, cwd, branch }
    })
  }

  private async clone(repository: string): Promise<string> {
    const dir = this.clonePath(repository)
    const auth = this.access.env(repository)
    try {
      if (!existsSync(join(dir, '.git'))) {
        mkdirSync(dirname(dir), { recursive: true })
        rmSync(dir, { recursive: true, force: true })
        await this.git(['clone', '--no-checkout', this.access.remote(repository), dir], dirname(dir), auth)
      } else {
        await this.git(['fetch', '--prune', 'origin'], dir, auth)
      }
    } catch (e) {
      if (!existsSync(join(dir, '.git'))) rmSync(dir, { recursive: true, force: true })
      throw new RepositoryAccessError(
        repository,
        this.redact(e instanceof Error ? e.message : String(e)),
        accessStatus(e),
      )
    }
    await this.git(['config', 'core.hooksPath', this.hooks], dir)
    return dir
  }

  async remove(ticketId: string): Promise<void> {
    rmSync(this.branchesPath(ticketId), { force: true })
    const path = this.worktreePath(ticketId)
    if (!existsSync(path)) return
    const common = existsSync(join(path, '.git'))
      ? (await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path).catch(() => '')).trim()
      : ''
    rmSync(path, { recursive: true, force: true })
    if (common) await this.git(['--git-dir', common, 'worktree', 'prune'], this.stateDir).catch(() => '')
  }

  async history(cwd: string): Promise<string> {
    return (await this.git(['log', '--oneline', '-n', '20'], cwd).catch(() => '')).trim()
  }

  /** Git location computed from the host state, never from `<cwd>/.git`, which the agent may rewrite. */
  private repository(cwd: string): string[] {
    const work = resolve(cwd)
    if (work !== this.worktreePath(basename(work))) throw new Error(NO_WORKTREE)
    let real: string
    try {
      real = realpathSync(work)
    } catch {
      throw new Error(NO_WORKTREE)
    }
    const repos = join(this.stateDir, 'repos')
    let clones: string[]
    try {
      clones = readdirSync(repos)
    } catch {
      throw new Error(NO_WORKTREE)
    }
    for (const repo of clones) {
      const admin = join(repos, repo, '.git', 'worktrees')
      let names: string[]
      try {
        names = readdirSync(admin)
      } catch {
        continue
      }
      for (const name of names) {
        try {
          const target = readFileSync(join(admin, name, 'gitdir'), 'utf8').trim()
          if (realpathSync(dirname(resolve(join(admin, name), target))) === real)
            return ['--git-dir=' + join(admin, name), '--work-tree=' + work]
        } catch {
          continue
        }
      }
    }
    throw new Error(NO_WORKTREE)
  }

  async head(cwd: string): Promise<string> {
    return (await this.git([...this.repository(cwd), ...GIT_READ_OPTIONS, 'rev-parse', 'HEAD'], cwd)).trim()
  }

  private async reviewBase(cwd: string, repo: string[]): Promise<string> {
    const configured = this.fixedBranches(basename(resolve(cwd)))?.from
    if (configured === undefined) return 'origin/HEAD'
    const present = await this.git(
      [...repo, ...GIT_READ_OPTIONS, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + configured],
      cwd,
    ).then(
      () => true,
      () => false,
    )
    return present ? 'refs/remotes/origin/' + configured : 'origin/HEAD'
  }

  async diffStat(cwd: string, base?: string): Promise<DiffStat> {
    const repo = this.repository(cwd)
    const known =
      base !== undefined &&
      SHA.test(base) &&
      (await this.git([...repo, ...GIT_READ_OPTIONS, 'cat-file', '-e', base + '^{commit}'], cwd).then(
        () => true,
        () => false,
      ))
    const from =
      base !== undefined && known
        ? base
        : (
            await this.git([...repo, ...GIT_READ_OPTIONS, 'merge-base', await this.reviewBase(cwd, repo), 'HEAD'], cwd)
          ).trim()
    const out = await this.git(
      [...repo, ...GIT_READ_OPTIONS, 'diff', '--numstat', ...DIFF, '--end-of-options', from, 'HEAD', '--'],
      cwd,
    )
    let files = 0
    let changedLines = 0
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      files++
      const [added = '', deleted = ''] = line.split('\t')
      changedLines += (added === '-' ? 0 : Number(added) || 0) + (deleted === '-' ? 0 : Number(deleted) || 0)
    }
    return { base: from, files, changedLines }
  }

  async diffText(cwd: string, base: string, maxChars: number): Promise<DiffText> {
    if (!SHA.test(base)) throw new Error('The diff base must be a commit sha')
    const repo = this.repository(cwd)
    const diff = (extra: string[]) => [
      ...repo,
      ...GIT_READ_OPTIONS,
      'diff',
      ...extra,
      ...DIFF,
      '--end-of-options',
      base,
      'HEAD',
      '--',
    ]
    const full = await this.git(diff([]), cwd)
    if (full.length <= maxChars) return { text: full, truncated: false }
    const stat = await this.git(diff(['--stat']), cwd)
    return {
      text:
        full.slice(0, maxChars) +
        '\n[diff truncated at ' +
        maxChars +
        ' of ' +
        full.length +
        ' characters; summary of all changes:]\n' +
        stat,
      truncated: true,
    }
  }

  async inspect(cwd: string, request: GitInspectRequest): Promise<string> {
    const { argv, revs, maxLines } = gitInspectArgv(request)
    const repo = this.repository(cwd)
    for (const rev of revs) {
      try {
        await this.git(
          [...repo, ...GIT_READ_OPTIONS, 'rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{object}'],
          cwd,
        )
      } catch {
        throw new Error('Unknown revision ' + rev)
      }
    }
    const out = await this.git([...repo, ...argv], cwd, {}, { timeoutMs: GIT_INSPECT_LIMITS.timeoutMs })
    return truncateOutput(out, maxLines, GIT_INSPECT_LIMITS.outputBytes)
  }

  async push(ticket: Ticket, options: PushOptions): Promise<PushResult> {
    const coAuthors = options.coAuthors ?? []
    for (const entry of coAuthors)
      if (!CO_AUTHOR.test(entry)) throw new Error('A co-author is written as Name <email>: ' + entry)
    const repository = this.repositoryOf(ticket)
    const cwd = this.worktreePath(ticket.id)
    if (!existsSync(join(cwd, '.git'))) throw new Error('This ticket has no worktree to publish')
    return this.serial(repository, async () => {
      const branch = (await this.git(['branch', '--show-current'], cwd)).trim()
      if (!branch.startsWith('agent/')) throw new Error('The worktree is not on its agent branch')
      const clone = await this.clone(repository)
      const fixed = this.fixedBranches(ticket.id)
      const target = fixed?.to ?? fixed?.from
      let base: string
      if (target) {
        if (!(await this.remoteHas(clone, target)))
          throw new WorkspaceBlocked(
            `${repository} has no branch ${target} to open the pull request against, so nothing was pushed and no pull request was opened. A person must create the branch or change branchFrom or pullRequestTo for ${repository} in the config.`,
          )
        base = target
      } else {
        base = (await this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], clone))
          .trim()
          .replace(/^origin\//, '')
      }
      const uncommitted = (await this.git(['status', '--porcelain'], cwd)).trim() !== ''
      const list = (await this.git(['rev-list', '--reverse', '--topo-order', 'HEAD', '--not', '--remotes=origin'], cwd))
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      let rewritten = 0
      if (list.length) {
        const map = new Map<string, string>()
        for (const sha of list) {
          const parents = (await this.git(['rev-list', '--parents', '-n', '1', sha], cwd)).trim().split(' ').slice(1)
          const [an, ae, ad, cn, ce, cd, tree] = (
            await this.git(['show', '-s', '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%T', sha], cwd)
          )
            .trim()
            .split('\u0000')
          const msg = await this.git(['show', '-s', '--format=%B', sha], cwd)
          const next = stripAiAttribution(coAuthorTrailers(msg, coAuthors))
          const np = parents.map(parent => map.get(parent) ?? parent)
          if (next === msg && np.length === parents.length && np.every((parent, i) => parent === parents[i])) {
            map.set(sha, sha)
          } else {
            const commit = (
              await this.git(
                ['commit-tree', '--no-gpg-sign', tree ?? '', ...np.flatMap(parent => ['-p', parent]), '-m', next],
                cwd,
                {
                  GIT_AUTHOR_NAME: an ?? '',
                  GIT_AUTHOR_EMAIL: ae ?? '',
                  GIT_AUTHOR_DATE: ad ?? '',
                  GIT_COMMITTER_NAME: cn ?? '',
                  GIT_COMMITTER_EMAIL: ce ?? '',
                  GIT_COMMITTER_DATE: cd ?? '',
                },
              )
            ).trim()
            map.set(sha, commit)
            rewritten++
          }
        }
        const old = (await this.git(['rev-parse', 'HEAD'], cwd)).trim()
        const replacement = map.get(old)
        if (replacement !== undefined && replacement !== old)
          await this.git(['update-ref', 'refs/heads/' + branch, replacement, old], cwd)
      }
      const remoteExists = await this.git(
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch],
        cwd,
      ).then(
        () => true,
        () => false,
      )
      if (list.length === 0 && !remoteExists)
        throw new Error('There are no commits to publish; commit the change first')
      if (list.length > 0) {
        for (let attempt = 1; ; attempt++) {
          try {
            await this.git(['push', 'origin', 'HEAD:refs/heads/' + branch], cwd, this.access.env(repository))
            break
          } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error
            const message = this.redact(error instanceof Error ? error.message : String(error))
            const failure = pushFailure(message, accessStatus(error))
            if (failure.kind === 'rejected')
              throw new Error(
                'The push was rejected without force; the remote branch has commits this worktree lacks: ' + message,
              )
            if (failure.kind === 'access') throw new RepositoryAccessError(repository, message, failure.status)
            if (attempt >= PUSH_ATTEMPTS)
              throw new Error(`The push still failed after ${PUSH_ATTEMPTS} attempts by the host: ${message}`)
            await this.sleep(PUSH_BACKOFF_MS[attempt - 1] ?? PUSH_BACKOFF_MS.at(-1)!)
          }
        }
      }
      return {
        repository,
        branch,
        base,
        head: (await this.git(['rev-parse', 'HEAD'], cwd)).trim(),
        pushed: list.length,
        rewritten,
        uncommitted,
      }
    })
  }
}

export class ScratchWorkspaces implements WorkspaceProvider {
  private readonly stateDir: string
  private readonly repositoryOf: (ticket: Ticket) => string

  constructor(options: { stateDir: string; repositoryOf(ticket: Ticket): string }) {
    this.stateDir = options.stateDir
    this.repositoryOf = options.repositoryOf
  }

  async prepare(ticket: Ticket, name: string): Promise<Workspace> {
    const cwd = join(this.stateDir, 'work', ticket.id)
    mkdirSync(cwd, { recursive: true })
    return { repository: this.repositoryOf(ticket), cwd, branch: 'agent/' + name }
  }

  async remove(id: string): Promise<void> {
    rmSync(join(this.stateDir, 'work', id), { recursive: true, force: true })
  }

  async history(): Promise<string> {
    return ''
  }

  async push(): Promise<PushResult> {
    throw new Error('Publishing needs a git workspace; this run uses scratch directories')
  }

  async head(): Promise<string> {
    return ''
  }

  async diffStat(): Promise<DiffStat> {
    return { base: '', files: 0, changedLines: 0 }
  }

  async diffText(): Promise<DiffText> {
    return { text: '', truncated: false }
  }

  async inspect(): Promise<string> {
    throw new Error(NO_WORKTREE)
  }
}
