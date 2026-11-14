import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SANDBOX_DOC } from '../src/app/credentials.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const deploy = read('docs/deploy.md')
const security = read('docs/security.md')
const gettingStarted = read('docs/getting-started.md')
const readme = read('README.md')

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
      'docker build -t issuecrew:local .',
      '/var/lib/issuecrew',
      '/etc/issuecrew/issuecrew.json',
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

  it('install and image docs do not ask for gh', () => {
    const req = gettingStarted.split('\n').find(l => l.startsWith('Requirements:')) ?? ''
    expect(req).toMatch(/Node\.js 22\.19/)
    expect(req).toMatch(/\bgit 2\.32/)
    expect(req).not.toMatch(/\bgh\b/)
    expect(gettingStarted).not.toMatch(/\bgh\b/)
    expect(readme).not.toMatch(/\bgh\b/)
    const tools = deploy.split('\n').find(l => l.startsWith('The image has the tools')) ?? ''
    expect(tools).toContain('git')
    expect(tools).toContain('ripgrep')
    expect(tools).toContain('the sandbox')
    expect(tools).not.toMatch(/\bgh\b/)
    for (const text of [gettingStarted, deploy]) {
      expect(text).not.toMatch(/\.docs\//)
      expect(text).not.toMatch(/\bM[0-9]+\b/)
    }
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

  it('security.md describes allowLocalBinding and no longer names canUseTool', () => {
    for (const text of [
      'security.allowLocalBinding',
      'loopback',
      'localhost',
      'network.allow',
      'restart',
      'macOS',
      'Linux',
      'may have no effect',
    ])
      expect(security).toContain(text)
    expect(security).not.toContain('canUseTool')
  })

  it('deploy.md lists the local binding limit', () => {
    const limits = deploy.slice(
      deploy.indexOf('## Known limitations'),
      deploy.indexOf('## Next', deploy.indexOf('## Known limitations')),
    )
    expect(limits).toContain('security.allowLocalBinding: false')
    expect(limits).toContain('in-process server')
    expect(limits).not.toContain('Both are open')
  })
})
