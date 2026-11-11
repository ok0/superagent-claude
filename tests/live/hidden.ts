import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { runNodeTests } from './rules.ts'
import type { LiveScenario } from './scenarios.ts'

export const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
export const SEED_DIR = join(FIXTURES_DIR, 'playground-seed')
export const HIDDEN_TIMEOUT_MS = 600_000
export const NETWORK_ERROR_RE = /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ESOCKETTIMEDOUT|network (?:read )?timeout|socket hang up/i
export const NPM_CACHE_DIR = join(tmpdir(), 'sac-live-npm-cache-' + (process.env.SAC_LIVE_RUN_ID ?? String(process.pid)))

export interface CommandResult { code: number; output: string; timedOut: boolean }

export function runCommand(command: string, args: readonly string[], o: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number }): Promise<CommandResult> {
  return new Promise(resolvePromise => {
    const child = spawn(command, [...args], { cwd: o.cwd, env: { ...o.env } })
    const chunks: string[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolvePromise({ code: 124, output: chunks.join('') + '\ntimed out after ' + o.timeoutMs + ' ms', timedOut: true })
    }, o.timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    child.on('error', error => {
      clearTimeout(timer)
      resolvePromise({ code: 127, output: chunks.join('') + error.message, timedOut: false })
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, output: chunks.join(''), timedOut: false })
    })
  })
}

export type Install = (root: string, env: Readonly<Record<string, string>>, timeoutMs: number) => Promise<{ code: number; output: string }>

export const npmCiArgs = ['ci', '--no-audit', '--no-fund', '--fetch-timeout=120000', '--fetch-retries=4', '--fetch-retry-mintimeout=5000', '--fetch-retry-maxtimeout=60000', '--prefer-offline'] as const

export const npmCi: Install = (root, env, timeoutMs) => runCommand('npm', [...npmCiArgs], { cwd: root, env, timeoutMs })

export interface InstallAttempt { attempt: number; code: number; networkError: boolean; seconds: number }
export interface InstallOutcome { ok: boolean; code: number; output: string; attempts: InstallAttempt[]; environment: boolean }

export async function installWithRetry(root: string, env: Readonly<Record<string, string>>, deadlineRemaining: () => number, o: { install?: Install; maxAttempts?: number; backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}): Promise<InstallOutcome> {
  const install = o.install ?? npmCi
  const maxAttempts = o.maxAttempts ?? 3
  const backoffMs = o.backoffMs ?? [5000, 15000]
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(resolvePromise => setTimeout(resolvePromise, ms)))
  const attempts: InstallAttempt[] = []
  let last: { code: number; output: string } = { code: 1, output: '' }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const started = Date.now()
    const result = await install(root, env, deadlineRemaining())
    const networkError = result.code !== 0 && NETWORK_ERROR_RE.test(result.output)
    attempts.push({ attempt, code: result.code, networkError, seconds: Math.round((Date.now() - started) / 1000) })
    last = result
    if (result.code === 0) return { ok: true, code: 0, output: result.output, attempts, environment: false }
    if (!networkError || attempt >= maxAttempts) break
    const wait = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0
    if (deadlineRemaining() <= wait) break
    await sleep(wait)
  }
  const lines = attempts.map(a => 'attempt ' + a.attempt + ': exit ' + a.code + ' (' + (a.networkError ? 'network' : 'other') + ')')
  return { ok: false, code: last.code, output: lines.join('\n') + '\n' + last.output.slice(-4000), attempts, environment: attempts.every(a => a.networkError) }
}

export interface HiddenOptions { fetchTree: (sha: string, dir: string) => Promise<unknown>; install?: Install; timeoutMs?: number; fixturesDir?: string; cacheDir?: string; sleep?: (ms: number) => Promise<void>; maxInstallAttempts?: number; installBackoffMs?: readonly number[] }
export interface HiddenRun { env: Readonly<Record<string, string>>; code: number; timedOut: boolean }
export interface HiddenResult { passed: boolean; runs: number; output: string; exits: HiddenRun[]; install?: { attempts: InstallAttempt[]; environment: boolean; failed: boolean } }

export async function runHidden(prHead: string, scenario: LiveScenario, options: HiddenOptions): Promise<HiddenResult> {
  const hidden = scenario.hidden
  if (!hidden) throw new Error('scenario ' + scenario.id + ' has no hidden tests')
  for (const p of [hidden.dest, hidden.workspace]) {
    if (isAbsolute(p) || p.split(/[\\/]/).includes('..')) throw new Error('unsafe hidden path: ' + p)
  }
  const src = resolve(options.fixturesDir ?? FIXTURES_DIR, hidden.dir)
  if (!existsSync(src)) throw new Error('hidden fixture does not exist: ' + hidden.dir)
  if (src === SEED_DIR || src.startsWith(SEED_DIR + sep)) throw new Error('hidden fixture must not be inside the seed: ' + hidden.dir)
  const deadline = Date.now() + (options.timeoutMs ?? HIDDEN_TIMEOUT_MS)
  const remaining = (): number => deadline - Date.now()
  const root = mkdtempSync(join(tmpdir(), 'sac-hidden-tree-'))
  const home = mkdtempSync(join(tmpdir(), 'sac-hidden-home-'))
  const cache = options.cacheDir ?? NPM_CACHE_DIR
  mkdirSync(cache, { recursive: true })
  const base = { PATH: process.env.PATH ?? '', HOME: home }
  try {
    await options.fetchTree(prHead, root)
    cpSync(src, join(root, hidden.dest), { recursive: true })
    const installed = await installWithRetry(root, { ...base, npm_config_cache: cache, npm_config_update_notifier: 'false' }, remaining, { install: options.install, maxAttempts: options.maxInstallAttempts, backoffMs: options.installBackoffMs, sleep: options.sleep })
    const installInfo = { attempts: installed.attempts, environment: installed.environment }
    if (!installed.ok) return { passed: false, runs: 0, output: (installed.environment ? 'install-failed (environment)\n' : 'install failed\n') + installed.output, exits: [], install: { ...installInfo, failed: true } }
    const [first = '', ...rest] = hidden.command
    const bin = first === 'node' ? process.execPath : first
    const matrix: readonly Readonly<Record<string, string>>[] = hidden.envMatrix?.length ? hidden.envMatrix : [{}]
    const repeat = hidden.repeat ?? 1
    const chunks: string[] = []
    let runs = 0
    let failed = false
    const exits: HiddenRun[] = []
    outer: for (const entry of matrix) {
      for (let i = 0; i < repeat; i++) {
        if (remaining() <= 0) {
          chunks.push('timed out before run ' + (runs + 1))
          failed = true
          break outer
        }
        const result = await runCommand(bin, rest, { cwd: join(root, hidden.workspace), env: { ...base, ...entry }, timeoutMs: remaining() })
        runs++
        exits.push({ env: entry, code: result.code, timedOut: result.timedOut })
        chunks.push('--- run ' + runs + ' ' + JSON.stringify(entry) + ' exit ' + result.code + '\n' + result.output)
        if (result.code !== 0 || result.timedOut) failed = true
        if (result.timedOut) break outer
      }
    }
    return { passed: !failed && runs === matrix.length * repeat, runs, output: chunks.join('\n').slice(-20_000), exits, install: { ...installInfo, failed: false } }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
}

export interface BaseFailure { passed: boolean; reason?: 'no-new-test' | 'base-fails-already' | 'new-test-passes-on-base'; pristineCode: number | null; preFixCode: number | null; testFiles: string[]; output: string }

export async function testsFailOnBase(o: { base: string; head: string; testFiles: readonly string[]; cwd?: string; run?: (dir: string) => Promise<{ code: number; output: string }> }): Promise<BaseFailure> {
  const cwd = o.cwd ?? ''
  const run = o.run ?? ((dir: string) => runNodeTests(dir))
  if (o.testFiles.length === 0) return { passed: false, reason: 'no-new-test', pristineCode: null, preFixCode: null, testFiles: [], output: '' }
  const pristine = await run(join(o.base, cwd))
  if (pristine.code !== 0) return { passed: false, reason: 'base-fails-already', pristineCode: pristine.code, preFixCode: null, testFiles: [...o.testFiles], output: pristine.output.slice(-4000) }
  for (const f of o.testFiles) {
    mkdirSync(dirname(join(o.base, f)), { recursive: true })
    copyFileSync(join(o.head, f), join(o.base, f))
  }
  const preFix = await run(join(o.base, cwd))
  const passed = preFix.code !== 0
  const result: BaseFailure = { passed, pristineCode: pristine.code, preFixCode: preFix.code, testFiles: [...o.testFiles], output: preFix.output.slice(-4000) }
  if (!passed) result.reason = 'new-test-passes-on-base'
  return result
}

export interface LocalCiResult { code: number; step: 'install' | 'typecheck' | 'test' | 'done'; output: string; attempts?: InstallAttempt[] }

export async function runLocalCi(root: string, o: { install?: Install; timeoutMs?: number; cacheDir?: string; sleep?: (ms: number) => Promise<void>; maxInstallAttempts?: number; installBackoffMs?: readonly number[] } = {}): Promise<LocalCiResult> {
  const home = mkdtempSync(join(tmpdir(), 'sac-local-ci-home-'))
  try {
    const cache = o.cacheDir ?? NPM_CACHE_DIR
    mkdirSync(cache, { recursive: true })
    const env = { PATH: process.env.PATH ?? '', HOME: home, npm_config_cache: cache, npm_config_update_notifier: 'false' }
    const deadline = Date.now() + (o.timeoutMs ?? 900_000)
    const remaining = (): number => deadline - Date.now()
    const installed = await installWithRetry(root, env, remaining, { install: o.install, maxAttempts: o.maxInstallAttempts, backoffMs: o.installBackoffMs, sleep: o.sleep })
    if (!installed.ok) return { code: installed.code, step: 'install', output: (installed.environment ? 'install-failed (environment)\n' : '') + installed.output.slice(-4000), attempts: installed.attempts }
    const typecheck = await runCommand('npm', ['run', 'typecheck'], { cwd: root, env, timeoutMs: remaining() })
    if (typecheck.code !== 0) return { code: typecheck.code, step: 'typecheck', output: typecheck.output.slice(-4000) }
    const tested = await runCommand('npm', ['test'], { cwd: root, env, timeoutMs: remaining() })
    if (tested.code !== 0) return { code: tested.code, step: 'test', output: tested.output.slice(-4000) }
    return { code: 0, step: 'done', output: '' }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
