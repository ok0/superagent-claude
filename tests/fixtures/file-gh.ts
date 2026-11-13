/**
 * A file-backed fake GitHub for daemon child processes: a --import preload makes the child's global fetch route through fakeGh against one JSON state file, and a kill rule makes the child SIGKILL itself before or after a matching POST.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { FAKE_HEADERS, API_HOST, fakeGh, readRequest, type FakeGhScript, type Posted } from './fake-gh.ts'

/** A string field with this value is answered as the current time. */
export const NOW = '<now>'

export interface KillRule {
  when: 'beforePost' | 'afterPost'
  path: string
}
export interface FileGhState {
  script: FakeGhScript
  posted: Posted[]
  kill?: KillRule
  killed?: KillRule & { at: string }
}
export const STATE_ENV = 'SUPERAGENT_CLAUDE_TEST_GITHUB_STATE'
const PRELOAD = fileURLToPath(new URL('./file-github-preload.ts', import.meta.url))

export interface FileGh {
  file: string
  env: Record<string, string>
  read(): FileGhState
  kill(rule: KillRule): void
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

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
  writeFileSync(
    tmp,
    JSON.stringify(state, (_key, value: unknown) => (value instanceof Set ? undefined : value)),
  )
  renameSync(tmp, file)
}

function read(file: string): FileGhState {
  return JSON.parse(readFileSync(file, 'utf8')) as FileGhState
}

export function fileGh(dir: string, script: FakeGhScript): FileGh {
  const root = join(dir, 'file-gh')
  const file = join(root, 'state.json')
  mkdirSync(root, { recursive: true })
  write(file, { script, posted: [] })
  return {
    file,
    env: { NODE_OPTIONS: `--no-warnings --import=${pathToFileURL(PRELOAD).href}`, [STATE_ENV]: file },
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

export function fileGithubFetch(file: string, previous: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (new URL(request.url).host !== API_HOST) return previous(input, init)
    const { method, path, fields } = await readRequest(request)
    acquire(file)
    const state = read(file)
    const bare = path.split('?')[0]!
    const hit = method === 'POST' && state.kill !== undefined && bare.endsWith('/' + state.kill.path)
    if (hit && state.kill!.when === 'beforePost') {
      state.killed = { ...state.kill!, at: new Date().toISOString() }
      delete state.kill
      write(file, state)
      release(file)
      process.kill(process.pid, 'SIGKILL')
      return new Promise<Response>(() => {})
    }
    let res: { status: number; data: unknown }
    try {
      res = fakeGh(state.script, { posted: state.posted }).answer(method, path, fields)
    } catch (error) {
      release(file)
      throw error
    }
    const body = JSON.stringify(res.data).split(JSON.stringify(NOW)).join(JSON.stringify(new Date().toISOString()))
    if (hit && state.kill!.when === 'afterPost') {
      state.killed = { ...state.kill!, at: new Date().toISOString() }
      delete state.kill
      write(file, state)
      release(file)
      process.kill(process.pid, 'SIGKILL')
      return new Promise<Response>(() => {})
    }
    try {
      write(file, state)
    } finally {
      release(file)
    }
    return new Response(body, { status: res.status, headers: FAKE_HEADERS })
  }
}
