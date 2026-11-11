import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
const api = join(import.meta.dirname, '..', '..')
const require = createRequire(join(api, 'package.json'))
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8'))
const major = (v: unknown): string => String(v).replace(/^[~^]/, '').split('.')[0] ?? ''
test('the api resolves @types/node 26', () => { assert.equal(major(json(require.resolve('@types/node/package.json')).version), '26') })
test('the api declaration and the lockfile agree on @types/node 26', () => {
  const pkg = json(join(api, 'package.json')); const declared = pkg.devDependencies?.['@types/node'] ?? pkg.dependencies?.['@types/node']
  assert.match(String(declared), /^[~^]?26\.\d+\.\d+$/)
  const lock = json(join(api, '..', 'package-lock.json')); const entry = lock.packages?.api
  assert.equal(entry?.devDependencies?.['@types/node'] ?? entry?.dependencies?.['@types/node'], declared)
  const installed = lock.packages?.['api/node_modules/@types/node'] ?? lock.packages?.['node_modules/@types/node']
  assert.equal(major(installed?.version), '26')
})
test('the api typechecks', () => {
  const tsc = join(dirname(require.resolve('typescript')), '..', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '--noEmit', '-p', api], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})
