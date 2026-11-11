import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readmeProblems } from './live/rules.ts'
import { loadSeed } from './live/seed-playground.ts'

const SEED = fileURLToPath(new URL('./live/fixtures/playground-seed', import.meta.url))
const LOCK_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']
const LINUX_NATIVE = ['node_modules/@rolldown/binding-linux-x64-gnu', 'node_modules/lightningcss-linux-x64-gnu']
const PINS = {
  dependencies: { react: '19.3.1', 'react-dom': '19.3.1' } as Record<string, string>,
  devDependencies: {
    vite: '8.3.5',
    '@vitejs/plugin-react': '6.1.2',
    vitest: '5.0.5',
    jsdom: '30.1.3',
    '@testing-library/react': '16.3.3',
    '@testing-library/dom': '10.4.2',
    '@testing-library/user-event': '14.6.8',
    '@types/react': '19.3.0',
    '@types/react-dom': '19.3.0',
    typescript: '6.0.3',
  } as Record<string, string>,
}

type LockEntry = {
  version?: string
  workspaces?: string[]
  optionalDependencies?: Record<string, string>
  link?: boolean
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function seedPaths(): string[] {
  return loadSeed(false).map(file => file.path)
}

function linuxLockfileProblems(lock: { packages?: Record<string, LockEntry> }): string[] {
  const packages = lock.packages ?? {}
  const problems: string[] = []
  for (const path of LINUX_NATIVE) if (!(path in packages)) problems.push('lockfile is missing ' + path)
  for (const [path, entry] of Object.entries(packages)) {
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      if (!/(^|[-/])linux-x64(-gnu)?$/.test(name)) continue
      if (packages['node_modules/' + name] || packages[path + '/node_modules/' + name]) continue
      problems.push('lockfile is missing ' + name + ' (optional of ' + path + ')')
    }
  }
  return [...new Set(problems)]
}

describe('web seed', () => {
  it('web workspace layout', () => {
    const root = readJson(join(SEED, 'package.json'))
    expect(root.workspaces).toEqual(['api', 'web'])
    expect(root.scripts).toEqual({
      typecheck: 'npm run typecheck --workspaces --if-present',
      test: 'npm test --workspaces --if-present',
    })
    expect(root.engines).toEqual({ node: '^24.15.0' })
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      expect(root[key]).toBeUndefined()

    const web = readJson(join(SEED, 'web', 'package.json'))
    expect(web.scripts).toEqual({ dev: 'vite', typecheck: 'tsc --noEmit', test: 'vitest run' })
    expect(web.dependencies).toEqual(PINS.dependencies)
    expect(web.devDependencies).toEqual(PINS.devDependencies)
    for (const key of ['peerDependencies', 'optionalDependencies']) expect(web[key]).toBeUndefined()
    const versions = {
      ...(web.dependencies as Record<string, string>),
      ...(web.devDependencies as Record<string, string>),
    }
    for (const version of Object.values(versions)) expect(version).toMatch(/^\d+\.\d+\.\d+$/)

    const paths = seedPaths()
    const lockNames = paths.filter(path => LOCK_NAMES.includes(basename(path)))
    expect(lockNames).toEqual(['package-lock.json'])
    for (const file of [
      'web/vite.config.ts',
      'web/tsconfig.json',
      'web/index.html',
      'web/src/main.tsx',
      'web/src/api/client.ts',
    ]) {
      expect(paths).toContain(file)
    }
    const components = paths.filter(
      path => /^web\/src\/components\/[^/]+\.tsx$/.test(path) && !path.endsWith('.test.tsx'),
    )
    expect(components.length).toBeGreaterThanOrEqual(6)
    expect(components.length).toBeLessThanOrEqual(8)
    const webTests = paths.filter(path => /^web\/src\/.+\.test\.tsx$/.test(path))
    expect(webTests.length).toBeGreaterThanOrEqual(5)
    expect(webTests.length).toBeLessThanOrEqual(7)
    const vite = readFileSync(join(SEED, 'web', 'vite.config.ts'), 'utf8')
    expect(vite).toMatch(/environment: ['"]jsdom['"]/)
    expect(vite).toContain('setupFiles')
  })

  it('lockfile pins the web packages', () => {
    const lock = readJson(join(SEED, 'package-lock.json')) as {
      lockfileVersion?: number
      packages?: Record<string, LockEntry>
    }
    expect(lock.lockfileVersion).toBe(3)
    const packages = lock.packages ?? {}
    expect(packages['']?.workspaces).toEqual(['api', 'web'])
    expect(packages['web']).toBeDefined()
    expect(packages['node_modules/@task-tracker/web']?.link).toBe(true)
    for (const [name, pin] of Object.entries({ ...PINS.dependencies, ...PINS.devDependencies })) {
      expect(packages['node_modules/' + name]?.version).toBe(pin)
    }
  })

  it('lockfile has the Linux x64 native packages', () => {
    const lock = readJson(join(SEED, 'package-lock.json')) as { packages?: Record<string, LockEntry> }
    expect(linuxLockfileProblems(lock)).toEqual([])
    for (const path of LINUX_NATIVE) {
      const copy = structuredClone(lock)
      delete copy.packages?.[path]
      const problems = linuxLockfileProblems(copy)
      expect(problems.length).toBeGreaterThan(0)
      expect(problems).toContain('lockfile is missing ' + path)
    }
    const synthetic = { packages: { 'node_modules/x': { optionalDependencies: { '@esbuild/linux-x64': '1.0.0' } } } }
    const problems = linuxLockfileProblems(synthetic)
    expect(problems.some(problem => problem.includes('@esbuild/linux-x64'))).toBe(true)
    for (const path of LINUX_NATIVE) expect(problems).toContain('lockfile is missing ' + path)
  })

  it('web files stay out of the node test runner', () => {
    const webPaths = seedPaths().filter(path => path.startsWith('web/'))
    expect(webPaths.length).toBeGreaterThan(0)
    for (const path of webPaths) {
      expect(basename(path)).not.toMatch(/^(test|test-.+|.+[.\-_]test)\.[cm]?[jt]s$/)
      expect(path).not.toContain('/test/')
    }
  })

  it('web source does not read the clock', () => {
    const sources = seedPaths().filter(path => path.startsWith('web/src/') && !path.endsWith('.test.tsx'))
    expect(sources.length).toBeGreaterThan(0)
    for (const path of sources) expect(readFileSync(join(SEED, path), 'utf8')).not.toMatch(/\bDate\b/)
  })

  it('README mentions the web workspace', () => {
    const readme = readFileSync(join(SEED, 'README.md'), 'utf8')
    expect(readmeProblems(readme)).toEqual([])
    expect(readme.split('\n').filter(line => line.includes('`web` workspace'))).toHaveLength(1)
  })
})
