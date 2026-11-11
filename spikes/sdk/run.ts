import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from './lib/harness.ts'
import { scanForSecrets, secretValues } from './lib/mask.ts'
import { isMain, type SpikeItem } from './lib/types.ts'
import { item as version } from './items/version.ts'
import { item as result } from './items/r13-result.ts'
import { item as steer } from './items/r09-steer.ts'
import { item as inputsRead } from './items/r10-inputs-read.ts'
import { item as laterInject } from './items/r11-later-inject.ts'
import { item as interrupt } from './items/r12-interrupt.ts'
import { item as backgroundBash } from './items/r14-background-bash.ts'
import { item as resume } from './items/r15-resume.ts'
import { item as pretooluseGuard } from './items/r16-pretooluse-guard.ts'
import { item as disallowedTools } from './items/r17-disallowed-tools.ts'
import { item as settingSources } from './items/r18-setting-sources.ts'
import { item as sandboxSecrets } from './items/r19-sandbox-secrets.ts'

export const ITEMS: SpikeItem[] = [
  version,
  result,
  steer,
  inputsRead,
  laterInject,
  interrupt,
  backgroundBash,
  resume,
  pretooluseGuard,
  disallowedTools,
  settingSources,
  sandboxSecrets,
]

const ROOT_URL = new URL('../../', import.meta.url)
const DEFAULT_OUT = fileURLToPath(new URL('.docs/spikes/sdk-semantics.md', ROOT_URL))

const EXIT_INTERNAL = 2
const EXIT_LEAK = 6

export function runStandalone(item: SpikeItem): Promise<number> {
  return execute({
    items: [item],
    env: process.env,
    stdout: s => process.stdout.write(s),
    stderr: s => process.stderr.write(s),
  })
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

export async function main(argv: readonly string[]): Promise<number> {
  const stdout = (s: string): void => {
    process.stdout.write(s)
  }
  const stderr = (s: string): void => {
    process.stderr.write(s)
  }

  const scan = valueAfter(argv, '--scan')
  if (scan !== undefined) {
    const findings = scanForSecrets(readFileSync(resolve(scan), 'utf8'), secretValues(process.env))
    for (const finding of findings) stdout(finding + '\n')
    if (findings.length === 0) {
      stdout('clean\n')
      return 0
    }
    return EXIT_LEAK
  }

  const only = valueAfter(argv, '--only')
  let items: SpikeItem[] = ITEMS
  if (only !== undefined) {
    const ids = only
      .split(',')
      .map(id => id.trim())
      .filter(id => id !== '')
    if (ids.length === 0) {
      stderr('--only requires at least one item id\n')
      return EXIT_INTERNAL
    }
    const known = new Set(ITEMS.map(item => item.id))
    const unknown = ids.filter(id => !known.has(id))
    if (unknown.length > 0) {
      stderr(`unknown item id: ${unknown.join(', ')}\n`)
      return EXIT_INTERNAL
    }
    items = ITEMS.filter(item => ids.includes(item.id))
  }

  const explicitOut = valueAfter(argv, '--out')
  const out = explicitOut ?? (only === undefined ? DEFAULT_OUT : undefined)

  return execute({ items, out, env: process.env, stdout, stderr })
}

if (isMain(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
