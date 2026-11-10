/** Tracks the runtime's child processes in <stateDir>/children.json and stops the ones an earlier host left running (ADR-32). */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SpawnOptions, SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'

export interface ChildEntry { pid: number; command: string }

export class ChildRegistry {
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  list(): ChildEntry[] {
    if (!existsSync(this.file)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return []
    }
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is ChildEntry => typeof entry?.pid === 'number' && typeof entry?.command === 'string')
  }

  add(entry: ChildEntry): void {
    this.write([...this.list(), entry])
  }

  remove(pid: number): void {
    this.write(this.list().filter(entry => entry.pid !== pid))
  }

  clear(): void {
    this.write([])
  }

  private write(entries: ChildEntry[]): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

export function trackedSpawn(registry: ChildRegistry, stderr?: (text: string) => void): (options: SpawnOptions) => SpawnedProcess {
  return options => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const pid = child.pid
    if (pid !== undefined) registry.add({ pid, command: options.command })
    const done = () => {
      if (pid !== undefined) registry.remove(pid)
    }
    child.once('exit', done)
    child.once('error', done)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      stderr?.(text)
    })
    return child
  }
}

export function commandLine(pid: number): string | undefined {
  try {
    const proc = `/proc/${pid}/cmdline`
    if (existsSync(proc)) {
      const line = readFileSync(proc, 'utf8').replace(/\0/g, ' ').trim()
      return line || undefined
    }
    const line = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return line || undefined
  } catch {
    return undefined
  }
}

export function isClaudeChild(line: string | undefined, entry: ChildEntry): boolean {
  return !!line && line.startsWith(entry.command) && /claude/i.test(line)
}

export interface ReapOptions {
  graceMs?: number
  pollMs?: number
  commandLine?: (pid: number) => string | undefined
  sleep?: (ms: number) => Promise<void>
}

export async function reapChildren(registry: ChildRegistry, options: ReapOptions = {}): Promise<number[]> {
  const graceMs = options.graceMs ?? 5000
  const pollMs = options.pollMs ?? 100
  const lookup = options.commandLine ?? commandLine
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const targets = registry.list().filter(entry => alive(entry.pid) && isClaudeChild(lookup(entry.pid), entry))
  for (const target of targets) {
    try { process.kill(target.pid, 'SIGTERM') } catch {}
  }
  const deadline = Date.now() + graceMs
  while (targets.some(target => alive(target.pid)) && Date.now() < deadline) {
    await sleep(pollMs)
  }
  for (const target of targets) {
    if (alive(target.pid)) {
      try { process.kill(target.pid, 'SIGKILL') } catch {}
    }
  }
  registry.clear()
  return targets.map(target => target.pid)
}
