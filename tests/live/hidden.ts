import { spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { runNodeTests } from './rules.ts'
import type { LiveScenario } from './scenarios.ts'

export const FIXTURES_DIR = join(import.meta.dirname, 'fixtures')
export const SEED_DIR = join(FIXTURES_DIR, 'playground-seed')
export const HIDDEN_TIMEOUT_MS = 600_000

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

export const npmCi: Install = (root, env, timeoutMs) => runCommand('npm', ['ci', '--no-audit', '--no-fund'], { cwd: root, env, timeoutMs })

export interface HiddenOptions { fetchTree: (sha: string, dir: string) => Promise<unknown>; install?: Install; timeoutMs?: number; fixturesDir?: string }
export interface HiddenResult { passed: boolean; runs: number; output: string }

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
  const base = { PATH: process.env.PATH ?? '', HOME: home }
  try {
    await options.fetchTree(prHead, root)
    cpSync(src, join(root, hidden.dest), { recursive: true })
    const install = options.install ?? npmCi
    const installed = await install(root, { ...base, npm_config_cache: join(home, '.npm'), npm_config_update_notifier: 'false' }, remaining())
    if (installed.code !== 0) return { passed: false, runs: 0, output: 'install failed\n' + installed.output }
    const [first = '', ...rest] = hidden.command
    const bin = first === 'node' ? process.execPath : first
    const matrix: readonly Readonly<Record<string, string>>[] = hidden.envMatrix?.length ? hidden.envMatrix : [{}]
    const repeat = hidden.repeat ?? 1
    const chunks: string[] = []
    let runs = 0
    let failed = false
    outer: for (const entry of matrix) {
      for (let i = 0; i < repeat; i++) {
        if (remaining() <= 0) {
          chunks.push('timed out before run ' + (runs + 1))
          failed = true
          break outer
        }
        const result = await runCommand(bin, rest, { cwd: join(root, hidden.workspace), env: { ...base, ...entry }, timeoutMs: remaining() })
        runs++
        chunks.push('--- run ' + runs + ' ' + JSON.stringify(entry) + ' exit ' + result.code + '\n' + result.output)
        if (result.code !== 0 || result.timedOut) failed = true
        if (result.timedOut) break outer
      }
    }
    return { passed: !failed && runs === matrix.length * repeat, runs, output: chunks.join('\n').slice(-20_000) }
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
