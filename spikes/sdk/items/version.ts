import { readFileSync } from 'node:fs'
import * as os from 'node:os'
import type { ItemResult, SpikeItem } from '../lib/types.ts'
import { isMain } from '../lib/types.ts'

const META = { id: 'version', req: 'R20', title: 'SDK 버전 고정·최소 요구' }
const SDK = '@anthropic-ai/claude-agent-sdk'

interface PkgJson {
  version?: string
  claudeCodeVersion?: string
  dependencies?: Record<string, string>
}

function readText(path: URL): string {
  return readFileSync(path, 'utf8')
}

function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

interface Check {
  name: string
  ok: boolean
  detail: string
}

async function run(): Promise<ItemResult> {
  const projectPkg = JSON.parse(readText(new URL('../../../package.json', import.meta.url))) as PkgJson
  const lock = readText(new URL('../../../pnpm-lock.yaml', import.meta.url))
  const sdkPkg = JSON.parse(
    readText(new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url)),
  ) as PkgJson
  const dts = readText(new URL('../../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url))

  const pin = projectPkg.dependencies?.[SDK]
  const installed = sdkPkg.version ?? '0.0.0'
  const cliVersion = sdkPkg.claudeCodeVersion ?? '0.0.0'
  const lockMatch = lock.match(/'@anthropic-ai\/claude-agent-sdk':\n\s+specifier: ([^\n]+)\n\s+version: ([^\n(]+)/)
  const lockSpec = lockMatch?.[1]?.trim()
  const lockVer = lockMatch?.[2]?.trim()
  const depKeys = Object.keys(projectPkg.dependencies ?? {})

  const checks: Check[] = [
    {
      name: 'pin-format',
      ok: pin !== undefined && /^\d+\.\d+\.\d+$/.test(pin),
      detail: `dependencies[${SDK}]=${pin ?? 'missing'}`,
    },
    {
      name: 'lockfile-importer',
      ok: pin !== undefined && lockSpec === pin && lockVer === pin,
      detail: `specifier=${lockSpec ?? 'missing'}, version=${lockVer ?? 'missing'}`,
    },
    {
      name: 'installed-equals-pin',
      ok: pin !== undefined && installed === pin,
      detail: `installed=${installed}`,
    },
    {
      name: 'sdk-min-0.3.317',
      ok: cmpSemver(installed, '0.3.317') >= 0,
      detail: `installed=${installed}`,
    },
    {
      name: 'cli-min-2.1.205',
      ok: cmpSemver(cliVersion, '2.1.205') >= 0,
      detail: `claudeCodeVersion=${cliVersion}`,
    },
    {
      name: 'sdk-d-ts-capabilities',
      ok: dts.includes('onFailure') && dts.includes('still_queued'),
      detail: `onFailure=${dts.includes('onFailure')}, still_queued=${dts.includes('still_queued')}`,
    },
    {
      name: 'sdk-in-dependencies',
      ok: depKeys.includes(SDK),
      detail: `dependencies=${depKeys.join(',') || 'none'}`,
    },
  ]

  const failed = checks.filter(c => !c.ok)
  const observations = [
    `sdkVersion=${installed}`,
    `cliVersion=${cliVersion}`,
    `node=${process.version}`,
    `os=${os.type()} ${os.release()} ${os.arch()}`,
    ...checks.map(c => `${c.name}: ${c.ok ? 'ok' : 'FAIL'} (${c.detail})`),
  ]

  return {
    ...META,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    deviation: false,
    summary:
      failed.length === 0
        ? `R20 최소 요구 충족 (SDK ${installed}, CLI ${cliVersion})`
        : `요구 미충족: ${failed.map(c => c.name).join(', ')}`,
    observations,
    evidence: [],
    attempts: 1,
    costs: [],
  }
}

export const item: SpikeItem = { ...META, adrs: '-', live: false, estimateUsd: 0, run }

if (isMain(import.meta.url)) {
  const { runStandalone } = await import('../run.ts')
  process.exitCode = await runStandalone(item)
}
