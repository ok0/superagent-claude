import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigSchema } from '../src/app/config.ts'
import { REQUIRED_ENV } from '../src/app/credentials.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const deploy = readFileSync(join(root, 'docs/deploy.md'), 'utf8')

const ATTRIBUTION = ''
const HYPE = /\b(blazing|revolutionary|seamless|cutting-edge|world-class|supercharg|effortless|game-chang|best-in-class)/i
const PRODUCT_NAME = /claude[ \t]+code/i

export function readmeProblems(text: string): string[] {
  const problems: string[] = []
  const attribution = text.split('\n').filter(line => line === ATTRIBUTION).length
  if (attribution !== 1) problems.push(`attribution line occurs ${attribution} times`)
  const mentions = text.match(/dsh-superagent-prototype/g)?.length ?? 0
  if (mentions !== 1) problems.push(`dsh-superagent-prototype is mentioned ${mentions} times`)
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

function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  if (start < 0) return ''
  const after = text.slice(start + heading.length)
  const next = after.search(/\n#/)
  return next < 0 ? after : after.slice(0, next)
}

const samples: [string, string][] = [
  ['a sentence twice', readme + `\n${ATTRIBUTION}\n`],
  ['an extra mention of the reference', readme + '\nSee dsh-superagent-prototype for more.\n'],
  ['a .docs/ link', readme + '\n[x](.docs/acceptance/PAC1.md)\n'],
  ['the forbidden product name', readme + '\n' + 'Claude' + ' Code' + ' is used here.\n'],
  ['the word seamless', readme + '\nA seamless setup.\n'],
]

describe('README and deploy doc', () => {
  it('README passes the attribution, link and wording rules', () => {
    expect(readmeProblems(readme)).toEqual([])
  })

  it.each(samples)('flags %s', (_name, sample) => {
    expect(readmeProblems(sample).length).toBeGreaterThan(0)
  })

  it('counts the settings of the schema as 19', () => {
    expect(schemaSettings()).toHaveLength(19)
  })

  it('states the setting count of the schema and names every setting', () => {
    const count = /has (\d+) settings/.exec(readme)?.[1]
    expect(count).toBe(String(schemaSettings().length))
    for (const path of schemaSettings()) expect(readme).toContain(`\`${path}\``)
  })

  it('names the start command, the read commands and the required settings', () => {
    for (const text of [
      'superagent-claude start [--config <path>]',
      'superagent-claude status',
      'superagent-claude needs',
      'superagent-claude prompts diff',
      'Required:',
      'auth.mode',
      'SUPERAGENT_CLAUDE_GITHUB_TOKEN',
      '`repositories`',
      '`policy.allowed`',
      'Everything else has a default.',
    ]) expect(readme).toContain(text)
  })

  it('has a section per auth mode with its environment', () => {
    for (const mode of Object.keys(REQUIRED_ENV)) {
      const body = section(readme, `### ${mode}\n`)
      for (const name of REQUIRED_ENV[mode as keyof typeof REQUIRED_ENV].flat(2)) expect(body).toContain(name)
    }
    const subscription = section(readme, '### subscription\n')
    for (const text of ['auth.acceptSubscriptionSharedUseRisk', 'auth.owner', 'ToS', 'refuses to start']) expect(subscription).toContain(text)
  })

  it('states the agent account rules and the observe default', () => {
    for (const text of [
      'separate GitHub account',
      "Do not put the agent account's login in `policy.allowed`",
      'The default `policy.acceptMode` is `observe`',
      '`auto` must be set explicitly',
    ]) expect(readme).toContain(text)
  })

  it('links docs/deploy.md on exactly one line', () => {
    expect(readme.split('\n').filter(line => line.includes('](docs/deploy.md)'))).toHaveLength(1)
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
