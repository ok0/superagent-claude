/**
 * A file-backed fake gh for daemon child processes: routes through `fakeGh`, keeps the script and the posted comments in one JSON file shared by every gh call, and SIGKILLs the calling daemon once before or after a matching POST when the test sets a kill rule.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeGh, type FakeGhScript, type Posted } from './fake-gh.ts'

/** A string field with this value is answered as the current time. */
export const NOW = '<now>'

export interface KillRule { when: 'beforePost' | 'afterPost'; path: string }
export interface FileGhState { script: FakeGhScript; posted: Posted[]; kill?: KillRule; killed?: KillRule & { at: string } }
export interface FileGh { bin: string; file: string; read(): FileGhState; kill(rule: KillRule): void }

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

function acquire(file: string): void {
  const lock = file + '.lock'
  const started = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() - started > 10_000) throw new Error('file-gh lock timed out')
      sleepSync(5)
    }
  }
}

function release(file: string): void {
  rmSync(file + '.lock', { recursive: true, force: true })
}

function write(file: string, state: FileGhState): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, (_key, value: unknown) => value instanceof Set ? undefined : value))
  renameSync(tmp, file)
}

function read(file: string): FileGhState {
  return JSON.parse(readFileSync(file, 'utf8')) as FileGhState
}

export function fileGh(dir: string, script: FakeGhScript): FileGh {
  const root = join(dir, 'file-gh')
  const file = join(root, 'state.json')
  const bin = join(root, 'bin')
  mkdirSync(bin, { recursive: true })
  write(file, { script, posted: [] })
  const main = fileURLToPath(new URL('./file-gh-main.ts', import.meta.url))
  const program = join(bin, 'gh')
  writeFileSync(program, `#!/bin/sh\nexec '${process.execPath}' --no-warnings '${main}' '${file}' "$@"\n`)
  chmodSync(program, 0o755)
  return {
    bin,
    file,
    read: () => read(file),
    kill: rule => {
      acquire(file)
      try {
        const state = read(file)
        state.kill = rule
        write(file, state)
      } finally {
        release(file)
      }
    },
  }
}

export async function runFileGh(file: string, argv: string[]): Promise<{ code: number; stdout: string; stderr: string; killParent: boolean }> {
  acquire(file)
  try {
    const state = read(file)
    const post = argv.includes('POST')
    const path = argv[1] ?? ''
    const hit = post && state.kill !== undefined && path.endsWith('/' + state.kill.path)
    if (hit && state.kill!.when === 'beforePost') {
      state.killed = { ...state.kill!, at: new Date().toISOString() }
      delete state.kill
      write(file, state)
      return { code: 1, stdout: '', stderr: 'gh: stopped\n', killParent: true }
    }
    const gh = fakeGh(state.script, { posted: state.posted })
    let stdout = ''
    let stderr = ''
    let code = 0
    try {
      stdout = await gh.commands.run('gh', argv)
    } catch (error) {
      stderr = (error as Error).message + '\n'
      code = 1
    }
    stdout = stdout.split(JSON.stringify(NOW)).join(JSON.stringify(new Date().toISOString()))
    if (hit && state.kill!.when === 'afterPost') {
      state.killed = { ...state.kill!, at: new Date().toISOString() }
      delete state.kill
      write(file, state)
      return { code: 1, stdout: '', stderr: 'gh: stopped\n', killParent: true }
    }
    write(file, state)
    return { code, stdout, stderr, killParent: false }
  } finally {
    release(file)
  }
}
