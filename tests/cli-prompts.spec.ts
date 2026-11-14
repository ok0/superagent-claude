import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HELP, main, type CliIo } from '../src/cli/main.ts'
import { Prompts, PromptVersions } from '../src/app/prompts.ts'
import { databasePath, Store } from '../src/app/store.ts'
import { packagePath } from '../src/infra/paths.ts'

const dirs: string[] = []
const NO_CHANGE = 'No built-in prompt changes affect the team sections.\n'

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-prompts-'))
  dirs.push(dir)
  return dir
}

function setup(): { dir: string; configPath: string; stateDir: string; teamDir: string } {
  const dir = tempDir()
  const configPath = join(dir, 'issuecrew.json')
  writeFileSync(
    configPath,
    JSON.stringify({ repositories: ['owner/repo'], policy: { allowed: ['alice'] }, stateDir: './state' }),
  )
  const teamDir = join(dir, 'prompts', 'team')
  mkdirSync(teamDir, { recursive: true })
  writeFileSync(join(teamDir, 'communication.md'), 'Our communication')
  return { dir, configPath, stateDir: join(dir, 'state'), teamDir }
}

function io(cwd: string) {
  const out: string[] = []
  const err: string[] = []
  const handle: CliIo = {
    out: s => {
      out.push(s)
    },
    err: s => {
      err.push(s)
    },
    cwd,
    env: { HOME: '/home/test' },
    signals: { once: () => {} },
  }
  return { handle, out, err }
}

function fixtureAssets(dir: string, communicationBody: string): string {
  const root = join(dir, 'assets')
  cpSync(packagePath('prompts'), join(root, 'prompts'), { recursive: true })
  cpSync(packagePath('skills'), join(root, 'skills'), { recursive: true })
  const header = readFileSync(packagePath('prompts', 'team', 'communication.md'), 'utf8').split('\n')[0]!
  writeFileSync(join(root, 'prompts', 'team', 'communication.md'), `${header}\n${communicationBody}\n`)
  return root
}

function recordVersion(stateDir: string, teamDir: string, assetRoot?: string): void {
  const store = new Store(databasePath(stateDir))
  try {
    new Prompts({ versions: new PromptVersions(store), teamDir, ...(assetRoot ? { assetRoot } : {}) }).current('worker')
  } finally {
    store.close()
  }
}

describe('prompts diff', () => {
  it('prints the built-in change of an overridden section and exits 0', async () => {
    const { dir, configPath, stateDir, teamDir } = setup()
    recordVersion(stateDir, teamDir, fixtureAssets(dir, 'Old built-in line'))
    const { handle, out, err } = io(dir)
    expect(await main(['prompts', 'diff', '--config', configPath], handle)).toBe(0)
    const firstBodyLine = readFileSync(packagePath('prompts', 'team', 'communication.md'), 'utf8').split('\n')[1]
    const text = out.join('')
    expect(text).toContain('Communication (prompts/team/communication.md): the built-in default changed')
    expect(text).toContain('- Old built-in line')
    expect(text).toContain('+ ' + firstBodyLine)
    expect(err).toEqual([])
  })

  it('prints no change when the override base matches the built-in default', async () => {
    const { dir, configPath, stateDir, teamDir } = setup()
    recordVersion(stateDir, teamDir)
    const { handle, out } = io(dir)
    expect(await main(['prompts', 'diff', '--config', configPath], handle)).toBe(0)
    expect(out.join('')).toBe(NO_CHANGE)
  })

  it('reads without a lock while the daemon writes and does not modify the database', async () => {
    const { dir, configPath, stateDir, teamDir } = setup()
    recordVersion(stateDir, teamDir, fixtureAssets(dir, 'Old built-in line'))
    const store = new Store(databasePath(stateDir))
    try {
      const db = databasePath(stateDir)
      const digest = (): string => createHash('sha256').update(readFileSync(db)).digest('hex')
      const rowCount = (): number =>
        (store.db.prepare('SELECT COUNT(*) AS n FROM prompt_version').get() as { n: number }).n
      const before = digest()
      const rows = rowCount()
      const { handle } = io(dir)
      expect(await main(['prompts', 'diff', '--config', configPath], handle)).toBe(0)
      expect(rowCount()).toBe(rows)
      expect(digest()).toBe(before)
    } finally {
      store.close()
    }
  })

  it('exits 0 with no change when no database exists', async () => {
    const { dir, configPath, stateDir } = setup()
    expect(existsSync(databasePath(stateDir))).toBe(false)
    const { handle, out } = io(dir)
    expect(await main(['prompts', 'diff', '--config', configPath], handle)).toBe(0)
    expect(out.join('')).toBe(NO_CHANGE)
  })

  it('exits 2 on a config error and on unknown prompts commands or options', async () => {
    const { dir } = setup()
    const missing = io(dir)
    expect(await main(['prompts', 'diff', '--config', join(dir, 'missing.json')], missing.handle)).toBe(2)
    expect(missing.err.join('')).toContain('Config file not found')
    const show = io(dir)
    expect(await main(['prompts', 'show'], show.handle)).toBe(2)
    const bogus = io(dir)
    expect(await main(['prompts', 'diff', '--bogus'], bogus.handle)).toBe(2)
  })

  it('lists prompts diff in the help', () => {
    expect(HELP).toContain('prompts diff')
  })
})
