import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SANDBOX_DOC } from '../src/app/credentials.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const deploy = read('docs/deploy.md')
const security = read('docs/security.md')

const PRIVILEGED = /--privileged|privileged:\s*true/

function markdownFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = join(dir, name)
    if (statSync(join(root, path)).isDirectory()) return markdownFiles(path)
    return name.endsWith('.md') ? [path] : []
  })
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-')

describe('deploy and container docs', () => {
  it('deploy.md has the Docker and container sandbox sections', () => {
    for (const text of [
      '## Docker',
      '## Sandbox in containers',
      'docker build -t superagent-claude:local .',
      '/var/lib/superagent-claude',
      '/etc/superagent-claude/superagent-claude.json',
      'weakerNestedSandbox',
    ])
      expect(deploy).toContain(text)
  })

  it('the refusal points at an existing section', () => {
    expect(SANDBOX_DOC).toBe('docs/deploy.md#sandbox-in-containers')
    const anchor = SANDBOX_DOC.split('#')[1]
    const slugs = deploy
      .split('\n')
      .filter(line => line.startsWith('## '))
      .map(line => slug(line.slice(3)))
    expect(slugs).toContain(anchor)
  })

  it('security.md states the container cost', () => {
    for (const text of ['/proc', 'baseline', 'allowUnsandboxed', 'environ', 'Permission denied', '0.3.321'])
      expect(security).toContain(text)
  })

  it('does not claim that /proc is hidden', () => {
    expect(deploy).not.toMatch(/\/proc[^.\n]*is hidden/i)
    expect(security).not.toMatch(/\/proc[^.\n]*is hidden/i)
  })

  it('no full-privilege flag in docs or the Dockerfile', () => {
    for (const path of [...markdownFiles('docs'), 'README.md', 'Dockerfile'])
      expect(read(path), path).not.toMatch(PRIVILEGED)
  })
})
