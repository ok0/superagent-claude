// Offline checks of the image extension example and the deploy and README sections that describe it.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const toolchain = read('deploy/docker/Dockerfile.toolchain')
const deploy = read('docs/deploy.md')
const readme = read('README.md')

const SECRET_NAME = /(TOKEN|SECRET|PASSW|KEY|CREDENTIAL|OAUTH|AUTH)/i
const TOKEN_VALUE = /sk-ant-|gh[pousr]_[A-Za-z0-9]|github_pat_/

function section(text: string, heading: string): string {
  const rest = text.slice(text.indexOf(heading))
  const next = rest.indexOf('\n## ')
  return next === -1 ? rest : rest.slice(0, next)
}

function secretNames(dockerfile: string): string[] {
  return [...dockerfile.matchAll(/^(ENV|ARG)\s+(.*)$/gm)].flatMap(match =>
    (match[2] ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map(token => token.split('=')[0] ?? '')
      .filter(name => SECRET_NAME.test(name)),
  )
}

const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .trim()
    .replace(/ /g, '-')

const LIMITS = [
  'services',
  'databases',
  'browsers',
  'Docker inside the sandbox',
  'per-ticket setup',
  'worktree',
  'later review',
]

describe('image extension example', () => {
  it('takes the base image from a build arg and ends as uid 10001', () => {
    expect(toolchain).toMatch(/^ARG BASE=\S+$/m)
    expect(toolchain).toMatch(/^FROM \$\{BASE\}$/m)
    expect(toolchain.indexOf('ARG BASE')).toBeLessThan(toolchain.indexOf('FROM ${BASE}'))
    expect([...toolchain.matchAll(/^USER\s+(\S+)/gm)].at(-1)?.[1]).toBe('10001:10001')
    expect(toolchain).toContain('USER root')
    expect(toolchain).toContain('apt-get update')
    expect(toolchain).toContain('--no-install-recommends')
    expect(toolchain).toContain('rm -rf /var/lib/apt/lists/*')
    expect(toolchain).not.toMatch(/--privileged|privileged:\s*true/)
  })

  it('sets no secret-named ENV or ARG and holds no secret value', () => {
    expect(secretNames(toolchain)).toEqual([])
    expect(toolchain).not.toMatch(TOKEN_VALUE)
  })

  it('detects a secret-named ARG in a sample', () => {
    expect(secretNames('ARG GITHUB_TOKEN\nENV NPM_KEY=x\n')).toHaveLength(2)
  })

  it('deploy.md embeds the file byte for byte', () => {
    expect(deploy).toContain('```dockerfile\n' + toolchain + '```\n')
    expect(deploy.split('```dockerfile\n').length).toBe(2)
  })
})

describe('deploy and README sections', () => {
  it('explains FROM and the environment note', () => {
    const s = section(deploy, '## Extending the image')
    expect(s).toContain('`FROM`')
    expect(s).toContain('ghcr.io/ok0/issuecrew')
    expect(s).toContain('deploy/docker/Dockerfile.toolchain')
    expect(s).toContain('environment note')
    expect(s).toContain('](configuration.md#environment-notes)')
    expect(s).toContain('network.allow')
  })

  it('lists the known limitations in deploy.md and the README', () => {
    expect(LIMITS.filter(entry => !section(deploy, '## Known limitations').includes(entry))).toEqual([])
    expect(LIMITS.filter(entry => !section(readme, '## Known limitations').includes(entry))).toEqual([])
    expect(readme).toContain('](docs/deploy.md#known-limitations)')
  })

  it('describes running multiple accounts and projects', () => {
    const s = section(deploy, '## Running multiple accounts/projects')
    expect(s).toContain('its own config file, its own `stateDir` and its own `ISSUECREW_GITHUB_TOKEN`')
    expect(s).toContain('A second `start` with the same `stateDir` is refused')
    expect(s).toContain('one instance per repository')
    expect(s).toContain('Nothing detects two instances that watch the same repository')
    expect(s).toContain('its own Deployment and PVC')
    expect(s).toContain('no command that creates an instance')
  })

  it('links the new sections from the contents and the README', () => {
    expect(deploy).toContain('](#extending-the-image)')
    expect(deploy).toContain('](#running-multiple-accountsprojects)')
    expect(deploy).toContain('](#known-limitations)')
    const documentation = section(readme, '## Documentation').split('\n')
    expect(documentation.some(line => line.includes('](docs/deploy.md#running-multiple-accountsprojects)'))).toBe(true)
    const headings = deploy
      .split('\n')
      .filter(line => line.startsWith('## '))
      .map(line => slug(line.slice(3)))
    expect(headings).toContain('extending-the-image')
    expect(headings).toContain('running-multiple-accountsprojects')
    expect(headings).toContain('known-limitations')
  })
})
