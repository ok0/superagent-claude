// Static checks of the root Dockerfile and .dockerignore: non-root final USER, tini entrypoint,
// no secret-named ENV/ARG, required ignore entries, and no privileged mode.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|OAUTH)/i
const REQUIRED_IGNORES = ['.docs', '.env', 'node_modules']

export function dockerfileProblems(dockerfile: string, dockerignore: string): string[] {
  const problems: string[] = []
  const fromStarts = [...dockerfile.matchAll(/^FROM\s/gm)].map(m => m.index ?? 0)
  const finalStage = dockerfile.slice(fromStarts.at(-1) ?? 0)

  const users = [...finalStage.matchAll(/^USER\s+(\S+)/gm)]
  const lastUser = users.at(-1)?.[1]
  if (lastUser === undefined) {
    problems.push('final stage has no USER')
  } else if (!/^\d+(:\d+)?$/.test(lastUser)) {
    problems.push(`final USER is not numeric: ${lastUser}`)
  }

  if (!/^ENTRYPOINT\s+\["(\/usr\/bin\/)?tini",\s*"--"/m.test(finalStage)) {
    problems.push('ENTRYPOINT does not start with tini')
  }

  for (const m of dockerfile.matchAll(/^(ENV|ARG)\s+(.*)$/gm)) {
    const tokens = (m[2] ?? '').trim().split(/\s+/)
    const withEquals = tokens.every(t => t.includes('='))
    const names = withEquals || m[1] === 'ARG' ? tokens.map(t => t.split('=')[0] ?? '') : tokens.slice(0, 1)
    for (const name of names) {
      if (SECRET_NAME.test(name)) problems.push(`${m[1]} sets a secret-named variable: ${name}`)
    }
  }

  const ignored = new Set(dockerignore.split('\n').map(l => l.trim()))
  for (const entry of REQUIRED_IGNORES) {
    if (!ignored.has(entry)) problems.push(`.dockerignore lacks ${entry}`)
  }

  if (/--privileged|privileged:\s*true/.test(dockerfile)) problems.push('privileged mode is requested')

  return problems
}

const GOOD_DOCKERFILE = [
  'FROM node:24-bookworm-slim AS build',
  'ENV CI=true',
  'FROM node:24-bookworm-slim',
  'USER 10001:10001',
  'ENTRYPOINT ["/usr/bin/tini", "--", "superagent-claude"]',
  'CMD ["start"]',
  '',
].join('\n')
const GOOD_DOCKERIGNORE = '.docs\n.env\nnode_modules\n'

describe('dockerfile', () => {
  it('the root Dockerfile and .dockerignore pass', () => {
    const dockerfile = readFileSync(`${ROOT}/Dockerfile`, 'utf8')
    const dockerignore = readFileSync(`${ROOT}/.dockerignore`, 'utf8')
    expect(dockerfileProblems(dockerfile, dockerignore)).toEqual([])
    expect(dockerfile).toContain('FROM node:24-bookworm-slim')
    expect(dockerfile).toContain('VOLUME /var/lib/superagent-claude')
    expect(dockerfile).toContain("-iname 'readme*'")
    const aptLine = dockerfile.split('\n').find(l => l.includes('apt-get install')) ?? ''
    for (const pkg of ['git', 'bubblewrap', 'socat', 'ripgrep', 'ca-certificates', 'tini']) {
      expect(aptLine).toMatch(new RegExp(`\\b${pkg}\\b`))
    }
    expect(aptLine).not.toMatch(/\bgh\b/)
    expect(dockerfile).not.toMatch(/\bgh\b/)
  })

  it.each([
    ['USER node', GOOD_DOCKERFILE.replace('USER 10001:10001', 'USER node'), GOOD_DOCKERIGNORE],
    ['no USER', GOOD_DOCKERFILE.replace('USER 10001:10001\n', ''), GOOD_DOCKERIGNORE],
    [
      'ENTRYPOINT ["node"]',
      GOOD_DOCKERFILE.replace('ENTRYPOINT ["/usr/bin/tini", "--", "superagent-claude"]', 'ENTRYPOINT ["node"]'),
      GOOD_DOCKERIGNORE,
    ],
    [
      'ENV ANTHROPIC_API_KEY=x',
      GOOD_DOCKERFILE.replace('USER 10001:10001', 'ENV ANTHROPIC_API_KEY=x\nUSER 10001:10001'),
      GOOD_DOCKERIGNORE,
    ],
    [
      'ARG GITHUB_TOKEN',
      GOOD_DOCKERFILE.replace('USER 10001:10001', 'ARG GITHUB_TOKEN\nUSER 10001:10001'),
      GOOD_DOCKERIGNORE,
    ],
    [
      'ENV HOME=/h CLAUDE_CODE_OAUTH_TOKEN=x',
      GOOD_DOCKERFILE.replace('USER 10001:10001', 'ENV HOME=/h CLAUDE_CODE_OAUTH_TOKEN=x\nUSER 10001:10001'),
      GOOD_DOCKERIGNORE,
    ],
    ['dockerignore missing .env', GOOD_DOCKERFILE, '.docs\nnode_modules\n'],
    ['dockerignore missing .docs', GOOD_DOCKERFILE, '.env\nnode_modules\n'],
    ['dockerignore missing node_modules', GOOD_DOCKERFILE, '.docs\n.env\n'],
  ])('detects a violation: %s', (_name, dockerfile, dockerignore) => {
    expect(dockerfileProblems(dockerfile, dockerignore).length).toBeGreaterThan(0)
  })

  it('a numeric USER in an earlier stage does not count', () => {
    const dockerfile = [
      'FROM node:24-bookworm-slim AS build',
      'USER 10001',
      'FROM node:24-bookworm-slim',
      'ENTRYPOINT ["/usr/bin/tini", "--", "superagent-claude"]',
      '',
    ].join('\n')
    expect(dockerfileProblems(dockerfile, GOOD_DOCKERIGNORE)).toContain('final stage has no USER')
  })
})
