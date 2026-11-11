import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAllowedRepo } from './live/guard.ts'

const LIVE_DIR = join(import.meta.dirname, 'live')
const LOCAL_ONLY = ['repo-config.spec.ts']

const files = readdirSync(LIVE_DIR, { recursive: true })
  .map(String)
  .filter(name => name.endsWith('.ts'))
  .sort()
const text = (name: string): string => readFileSync(join(LIVE_DIR, name), 'utf8')
const contents = files.map(name => [name, text(name)] as const)
const withPattern = (pattern: RegExp): string[] => contents.filter(([, body]) => pattern.test(body)).map(([name]) => name)

describe('live guard static scan', () => {
  it('only gh.ts spawns gh', () => {
    expect(withPattern(/\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync|exec|execSync)\(\s*['"]gh['"]/)).toEqual(['gh.ts'])
  })

  it('git push only against a local origin', () => {
    const gitCall = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync)\(\s*['"]git['"]\s*,\s*\[([^\]]*)\]/g
    const pushers = new Set<string>()
    for (const [name, body] of contents) {
      for (const match of body.matchAll(gitCall)) {
        const argv = match[1] ?? ''
        if (!/(['"])push\1/.test(argv)) continue
        pushers.add(name)
        expect(argv, name).not.toContain('github.com')
        expect(argv, name).not.toMatch(/--force/)
        expect(argv, name).not.toMatch(/-f['"]/)
        expect(argv, name).not.toMatch(/['"]\+/)
      }
    }
    for (const name of pushers) expect(LOCAL_ONLY).toContain(name)
  })

  it('every literal repository is allowed', () => {
    const literal = /['"`]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]*superagent[A-Za-z0-9_.-]*)['"`]/g
    for (const [, body] of contents) {
      for (const match of body.matchAll(literal)) {
        const repo = match[1] ?? ''
        if (repo.includes('.ts') || repo.startsWith('../')) continue
        expect(isAllowedRepo(repo), repo).toBe(true)
      }
    }
    const graphql = /repository\s*\(\s*owner:\s*"([^"]*)"\s*,\s*name:\s*"([^"]*)"\s*\)/g
    for (const [, body] of contents) {
      for (const match of body.matchAll(graphql)) {
        expect(isAllowedRepo(match[1] + '/' + match[2]), String(match[0])).toBe(true)
      }
    }
  })

  it('specs that reach GitHub call the guard', () => {
    for (const [name, body] of contents) {
      if (LOCAL_ONLY.includes(name)) continue
      if (body.includes("main(['start'") || body.includes('new Commands(') || body.includes('new Workspaces(')) {
        expect(body.includes('assertAllowedRepo('), name).toBe(true)
      }
    }
  })

  it('no force, no deletes outside refs', () => {
    const deleteFiles: string[] = []
    for (const [name, body] of contents) {
      for (const line of body.split('\n')) {
        const stripped = line.replace(/\brm(?:Sync)?\([^)]*\)/g, '')
        expect(/\bforce['"]?\s*:\s*true\b/.test(stripped), name + ': ' + line.trim()).toBe(false)
        expect(/['"]--force(?:-with-lease)?['"]/.test(stripped), name + ': ' + line.trim()).toBe(false)
        if (line.includes('git/refs/heads/') && line.includes("'PATCH'")) {
          expect(name, line.trim()).toBe('seed-playground.ts')
          if (line.includes('JSON.stringify({ sha:')) expect(line).toContain('force: false')
        }
        if (!line.includes("'DELETE'")) continue
        expect(line.includes('git/refs/heads/'), name + ': ' + line.trim()).toBe(true)
        deleteFiles.push(name)
      }
    }
    for (const name of new Set(deleteFiles)) expect(['cleanup-playground.ts', 'code-change.spec.ts']).toContain(name)
  })

  it('milestone scans use the full pattern', () => {
    expect(withPattern(/M\\d\{1,2\}/)).toEqual([])
  })

  it('live files are not in the offline run', () => {
    const config = readFileSync(join(import.meta.dirname, '..', 'vitest.config.ts'), 'utf8')
    expect(config).toContain("'tests/live/**'")
    for (const name of files.filter(file => file.endsWith('.spec.ts'))) {
      expect(text(name), name).toMatch(/^describe\.skipIf\(/m)
      expect(text(name), name).not.toMatch(/^describe\(/m)
    }
  })

  it('contents writes only in the seed script', () => {
    for (const [name, body] of contents) {
      for (const line of body.split('\n')) {
        if (!line.includes("'PUT'")) continue
        expect(line, name).toContain('/contents/')
        expect(name, line.trim()).toBe('seed-playground.ts')
      }
    }
  })

  it('local gh credential only in the seed script and read-only checks', () => {
    expect(withPattern(/\bghLocal(?:Json|Raw)\b/)).toEqual(['gh.ts', 'seed-playground.ts'])
    for (const name of withPattern(/localIdentity\(/)) expect(['gh.ts', 'seed-playground.ts', 'code-change.spec.ts']).toContain(name)
  })
})
