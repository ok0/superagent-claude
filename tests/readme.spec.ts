
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigSchema } from '../src/app/config.ts'
import { REQUIRED_ENV } from '../src/app/credentials.ts'
import { checkText } from '../scripts/check-branding.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const readme = read('README.md')
const deploy = read('docs/deploy.md')
const gettingStarted = read('docs/getting-started.md')
const configuration = read('docs/configuration.md')
const authentication = read('docs/authentication.md')
const security = read('docs/security.md')
const svg = read('docs/assets/flow.svg')

const DOCS = ['docs/getting-started.md', 'docs/configuration.md', 'docs/authentication.md', 'docs/runtime-contract.md', 'docs/deploy.md', 'docs/security.md']

const HYPE = /\b(blazing|revolutionary|seamless|cutting-edge|world-class|supercharg|effortless|game-chang|best-in-class)/i
const PRODUCT_NAME = /claude[ \t]+code/i

export function readmeProblems(text: string): string[] {
  const problems: string[] = []
  const mentions = text.match(/dsh-superagent-prototype/g)?.length ?? 0
  if (mentions !== 0) problems.push(`dsh-superagent-prototype is mentioned ${mentions} times`)
  if (/\.docs\//.test(text)) problems.push('a .docs/ path appears')
  if (PRODUCT_NAME.test(text)) problems.push('the forbidden product name appears')
  const hype = HYPE.exec(text)
  if (hype) problems.push(`hype word: ${hype[0]}`)
  return problems
}

export function schemaSettings(): string[] {
  return Object.entries(ConfigSchema.shape).flatMap(([key, schema]) => {
    let inner: unknown = schema
    while (inner instanceof z.ZodDefault || inner instanceof z.ZodOptional) inner = inner.unwrap()
    return inner instanceof z.ZodObject ? Object.keys(inner.shape).map(k => `${key}.${k}`) : [key]
  })
}

export function linkProblems(file: string, text: string): string[] {
  const targets = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map(match => match[1] ?? ''),
    ...[...text.matchAll(/src="([^"]+)"/g)].map(match => match[1] ?? ''),
  ]
  const problems: string[] = []
  for (const raw of targets) {
    if (/^(https?:\/\/|mailto:|#)/.test(raw)) continue
    const target = raw.split('#')[0] ?? ''
    if (!existsSync(join(dirname(join(root, file)), target))) problems.push(`${file}: ${target}`)
  }
  return problems
}

function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const after = text.slice(start + heading.length)
  const next = after.search(/\n#/)
  return next < 0 ? after : after.slice(0, next)
}

const samples: [string, string][] = [
  ['a mention of the reference', readme + '\nSee dsh-superagent-prototype for more.\n'],
  ['a .docs/ link', readme + '\n[x](.docs/acceptance/PAC1.md)\n'],
  ['the forbidden product name', readme + '\n' + 'Claude' + ' Code' + ' is used here.\n'],
  ['the word seamless', readme + '\nA seamless setup.\n'],
]

describe('README and public docs', () => {
  it('README passes the attribution, link and wording rules', () => {
    expect(readmeProblems(readme)).toEqual([])
  })

  it.each(samples)('flags %s', (_name, sample) => {
    expect(readmeProblems(sample).length).toBeGreaterThan(0)
  })

  it('flags a broken link', () => {
    expect(linkProblems('README.md', readme + '\n[x](docs/missing.md)\n').length).toBeGreaterThan(0)
  })

  it('flags a broken image', () => {
    expect(linkProblems('README.md', '![a](docs/assets/missing.svg)').length).toBeGreaterThan(0)
  })

  it('counts the settings of the schema as 19', () => {
    expect(schemaSettings()).toHaveLength(19)
  })

  it('states the setting count of the schema and names every setting', () => {
    const count = /has (\d+) settings/.exec(configuration)?.[1]
    expect(count).toBe(String(schemaSettings().length))
    for (const path of schemaSettings()) expect(configuration).toContain(`\`${path}\``)
  })

  it('getting-started names the start command and the read commands', () => {
    for (const text of [
      'superagent-claude start [--config <path>]',
      'superagent-claude status',
      'superagent-claude needs',
      'superagent-claude prompts diff',
    ]) expect(gettingStarted).toContain(text)
  })

  it('configuration names the required settings', () => {
    for (const text of [
      'Required:',
      'auth.mode',
      'SUPERAGENT_CLAUDE_GITHUB_TOKEN',
      '`repositories`',
      '`policy.allowed`',
      'Everything else has a default.',
    ]) expect(configuration).toContain(text)
  })

  it('has a section per auth mode with its environment', () => {
    for (const mode of Object.keys(REQUIRED_ENV)) {
      const body = section(authentication, `## ${mode}\n`)
      for (const name of REQUIRED_ENV[mode as keyof typeof REQUIRED_ENV].flat(2)) expect(body).toContain(name)
    }
    const subscription = section(authentication, '## subscription\n')
    for (const text of ['auth.acceptSubscriptionSharedUseRisk', 'auth.owner', 'ToS', 'refuses to start']) expect(subscription).toContain(text)
  })

  it('states the agent account rules and the observe default', () => {
    for (const text of [
      'separate GitHub account',
      "Do not put the agent account's login in `policy.allowed`",
      'The default `policy.acceptMode` is `observe`',
      '`auto` must be set explicitly',
    ]) expect(gettingStarted).toContain(text)
  })

  it('links docs/deploy.md on exactly one line', () => {
    expect(readme.split('\n').filter(line => line.includes('](docs/deploy.md)'))).toHaveLength(1)
  })

  it('README is short and links the docs and the flow diagram', () => {
    expect(readme.split('\n').length).toBeLessThanOrEqual(50)
    for (const heading of ['## Quick start', '## Documentation', '## License']) expect(readme).toContain(heading)
    for (const path of DOCS) expect(readme).toContain(`](${path})`)
    expect(readme).toMatch(/!\[[^\]]+\]\(docs\/assets\/flow\.svg\)/)
    expect(readme).not.toMatch(/^## (Install|Agent account|Start|Configuration|Authentication)\b/m)
    expect(readme).not.toMatch(/^### (api-key|bedrock|vertex|subscription)$/m)
  })

  it('every relative link in the README and docs resolves', () => {
    const files: [string, string][] = [['README.md', readme], ...DOCS.map((path): [string, string] => [path, read(path)])]
    expect(files.flatMap(([file, text]) => linkProblems(file, text))).toEqual([])
  })

  it('the docs pass the wording rules', () => {
    for (const [path, text] of [
      ['docs/getting-started.md', gettingStarted],
      ['docs/configuration.md', configuration],
      ['docs/authentication.md', authentication],
      ['docs/security.md', security],
    ] as const) {
      expect(text, path).not.toMatch(/\.docs\//)
      expect(PRODUCT_NAME.test(text), path).toBe(false)
      expect(text, path).not.toMatch(/\bM\d{1,2}\b|milestone/i)
      expect(HYPE.test(text), path).toBe(false)
      expect(checkText(path, text), path).toEqual([])
    }
  })

  it('security.md states the trust policy', () => {
    for (const term of [
      'settingSources: []',
      "settingSources: ['project']",
      'core.hooksPath',
      '.mcp.json',
      'strictMcpConfig',
      'dontAsk',
      'bypassPermissions',
      'PreToolUse',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
      'network.allow',
      'failIfUnavailable',
      'allowUnsandboxed',
      'CLAUDE_CONFIG_DIR',
      'allowlist',
      'prompt injection',
      'acceptSubscriptionSharedUseRisk',
      'trustRepoConfig',
    ]) expect(security).toContain(term)
  })

  it('the flow diagram is a self-contained SVG with the five steps', () => {
    expect(svg.trimStart()).toMatch(/^(<\?xml[^>]*>\s*)?<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
    expect(svg.trimEnd().endsWith('</svg>')).toBe(true)
    expect(svg).not.toMatch(/<script|<foreignObject|<image\b|\bhref\s*=|@import|\son[a-z]+\s*=/i)
    expect(svg.match(/url\((?!#)/g)).toBeNull()
    expect(svg).toMatch(/<rect[^>]*width="100%"[^>]*height="100%"[^>]*fill="#[0-9a-fA-F]{6}"/)
    const text = svg.replace(/<[^>]+>/g, ' ')
    for (const label of ['mentions the agent', 'Allowlist', 'admission', 'Ticket', 'session', 'git worktree', 'comment', 'pull request']) expect(text).toContain(label)
    expect(svg).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{8,}|_pat_[A-Za-z0-9]|sk-ant-/)
    expect(svg).not.toMatch(/\bM\d{1,2}\b|milestone/i)
    expect(checkText('docs/assets/flow.svg', svg)).toEqual([])
  })

  it('deploy.md has a systemd unit and a launchd plist running start, with no secrets', () => {
    expect(existsSync(join(root, 'docs/deploy.md'))).toBe(true)
    expect(deploy).toMatch(/^ExecStart=.*superagent-claude start/m)
    expect(deploy).toContain('[Service]')
    const plistArgs = deploy.slice(deploy.indexOf('<key>ProgramArguments</key>'))
    expect(plistArgs.slice(0, plistArgs.indexOf('</array>'))).toContain('superagent-claude start')
    expect(deploy).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{8,}|_pat_[A-Za-z0-9]|sk-ant-/)
    for (const match of deploy.matchAll(/^(\w*(TOKEN|KEY|SECRET)\w*)=(.*)$/gm)) expect(match[3]).toMatch(/^<[^>]+>$/)
    expect(deploy).not.toContain('.docs/')
    expect(PRODUCT_NAME.test(deploy)).toBe(false)
  })
})
