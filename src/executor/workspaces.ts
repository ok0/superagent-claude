/** Worker workspaces: git worktrees on agent branches over one shared clone per repository, and scratch directories for fake runs. Clone and fetch get the injected access env (authentication) and errors mask its secrets. */
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Ticket } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import type { Workspace } from './worker-executor.ts'

export class RepositoryAccessError extends Error {
  readonly repository: string
  readonly reason: string
  constructor(repository: string, reason: string) {
    super(`Repository ${repository} could not be accessed: ${reason}`)
    this.name = 'RepositoryAccessError'
    this.repository = repository
    this.reason = reason
  }
}

export interface WorkspaceProvider {
  prepare(ticket: Ticket, name: string): Promise<Workspace>
  remove(ticketId: string): Promise<void>
  history(cwd: string): Promise<string>
}

export function worktreeName(ticket: Pick<Ticket, 'id' | 'execution'>): string {
  const slug = (ticket.execution?.name ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.\.+/g, '.').slice(0, 40)
  return slug ? `${slug}-${ticket.id.slice(0, 12)}` : ticket.id
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Where a repository is fetched from, the env that authenticates only the clone and fetch calls, and the values masked in errors. Provided by the Source assembly point so the executor never names the hosting service. */
export interface RepositoryAccess { remote(repository: string): string; env(repository: string): Record<string, string>; secrets: readonly string[] }

export interface WorkspacesOptions {
  stateDir: string
  commands: Pick<Commands, 'git'>
  repositoryOf(ticket: Ticket): string
  access: RepositoryAccess
}

export class Workspaces implements WorkspaceProvider {
  readonly hooks: string
  private readonly stateDir: string
  private readonly commands: Pick<Commands, 'git'>
  private readonly repositoryOf: (ticket: Ticket) => string
  private readonly access: RepositoryAccess
  private readonly chains = new Map<string, Promise<unknown>>()

  constructor(options: WorkspacesOptions) {
    this.stateDir = options.stateDir
    this.commands = options.commands
    this.repositoryOf = options.repositoryOf
    this.access = options.access
    this.hooks = join(options.stateDir, 'empty-hooks')
  }

  private git(args: string[], cwd: string, extra: Record<string, string> = {}): Promise<string> {
    return this.commands.git(['-c', `core.hooksPath=${this.hooks}`, ...args], cwd, extra)
  }

  private redact(text: string): string {
    for (const secret of this.access.secrets) if (secret) text = text.split(secret).join('***')
    return text
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (this.chains.get(key) ?? Promise.resolve()).then(run, run)
    this.chains.set(key, result.then(() => undefined, () => undefined))
    return result
  }

  worktreePath(ticketId: string): string {
    return join(this.stateDir, 'worktrees', ticketId)
  }

  clonePath(repository: string): string {
    return join(this.stateDir, 'repos', repository.replace('/', '__'))
  }

  async prepare(ticket: Ticket, name: string): Promise<Workspace> {
    if (!NAME.test(name) || name.includes('..') || name.endsWith('.lock')) throw new Error('Invalid worktree name: ' + name)
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
      const exists = await this.git(['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], base).then(() => true, () => false)
      await this.git(exists ? ['worktree', 'add', cwd, branch] : ['worktree', 'add', '--no-track', '-b', branch, cwd, 'origin/HEAD'], base)
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
      throw new RepositoryAccessError(repository, this.redact(e instanceof Error ? e.message : String(e)))
    }
    await this.git(['config', 'core.hooksPath', this.hooks], dir)
    return dir
  }

  async remove(ticketId: string): Promise<void> {
    const path = this.worktreePath(ticketId)
    if (!existsSync(path)) return
    const common = existsSync(join(path, '.git')) ? (await this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path).catch(() => '')).trim() : ''
    rmSync(path, { recursive: true, force: true })
    if (common) await this.git(['--git-dir', common, 'worktree', 'prune'], this.stateDir).catch(() => '')
  }

  async history(cwd: string): Promise<string> {
    return (await this.git(['log', '--oneline', '-n', '20'], cwd).catch(() => '')).trim()
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
}
