/**
 * The Kubernetes manifest: one replica with Recreate, non-root and hardened, probes and grace period,
 * empty Secret, and its verbatim copy in docs/deploy.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path: string): string => readFileSync(join(root, path), 'utf8')
const manifest = read('deploy/k8s/superagent-claude.yaml')
const deploy = read('docs/deploy.md')
const dockerfile = read('Dockerfile')

const REQUIRED_KINDS = ['ConfigMap', 'Secret', 'PersistentVolumeClaim', 'Deployment']

const DEPLOYMENT_REQUIRED = [
  /^  replicas: 1$/m,
  /^    type: Recreate$/m,
  /terminationGracePeriodSeconds: 30$/m,
  /runAsNonRoot: true/,
  /allowPrivilegeEscalation: false/,
  /drop: \["ALL"\]|drop:\s*\n\s*- ALL/,
  /seccompProfile:\s*\n\s*type: RuntimeDefault/,
  /automountServiceAccountToken: false/,
  /readinessProbe:\s*\n\s*exec:\s*\n\s*command: \[[^\]]*"health", "--ready"/,
  /livenessProbe:\s*\n\s*exec:\s*\n\s*command: \[[^\]]*"health", "--live"/,
  /"--log-format", "json"/,
  /requests:/,
  /limits:/,
  /mountPath: \/var\/lib\/superagent-claude$/m,
  /mountPath: \/etc\/superagent-claude$/m,
]

function documentsOf(text: string): string[] {
  return text.split(/^---$/m)
}

function kindOf(doc: string): string | undefined {
  return doc.match(/^kind: (\w+)$/m)?.[1]
}

function manifestProblems(text: string): string[] {
  const problems: string[] = []
  const docs = documentsOf(text)
  const kinds = docs.map(kindOf).filter((kind): kind is string => kind !== undefined)

  for (const kind of kinds) {
    if (!REQUIRED_KINDS.includes(kind)) problems.push(`unexpected kind ${kind}`)
  }
  for (const kind of REQUIRED_KINDS) {
    const count = kinds.filter(k => k === kind).length
    if (count !== 1) problems.push(`expected exactly one ${kind}, found ${count}`)
  }

  const whole: [RegExp, string][] = [
    [/privileged/i, 'privileged'],
    [/unconfined/i, 'unconfined'],
    [/host(PID|Network|IPC):\s*true/, 'host namespace sharing'],
    [/^\s*namespace:/m, 'namespace set'],
    [/\bM\d+\b/, 'milestone ID'],
    [/milestone/i, 'milestone'],
    [/\bgh[pousr]_[A-Za-z0-9_]{16,}|sk-ant-|_pat_/, 'token shape'],
  ]
  for (const [pattern, label] of whole) {
    if (pattern.test(text)) problems.push(`forbidden: ${label}`)
  }

  const deployment = docs.find(doc => kindOf(doc) === 'Deployment') ?? ''
  for (const pattern of DEPLOYMENT_REQUIRED) {
    if (!pattern.test(deployment)) problems.push(`deployment missing ${pattern.source}`)
  }
  const runAsUsers = [...deployment.matchAll(/runAsUser: (\d+)/g)].map(m => Number(m[1]))
  const runAsGroups = [...deployment.matchAll(/runAsGroup: (\d+)/g)].map(m => Number(m[1]))
  if (runAsUsers.length === 0) problems.push('no runAsUser')
  for (const value of [...runAsUsers, ...runAsGroups]) {
    if (!Number.isInteger(value) || value <= 0) problems.push(`run-as id must be > 0, got ${value}`)
  }
  const periods = [...deployment.matchAll(/periodSeconds: (\d+)/g)].map(m => Number(m[1]))
  if (periods.length < 2) problems.push('fewer than two periodSeconds')
  for (const value of periods) {
    if (value < 10) problems.push(`periodSeconds below 10: ${value}`)
  }

  const secret = docs.find(doc => kindOf(doc) === 'Secret') ?? ''
  const secretLines = secret.split('\n')
  const start = secretLines.indexOf('stringData:')
  const entries: string[] = []
  if (start >= 0) {
    for (const line of secretLines.slice(start + 1)) {
      if (!line.startsWith('  ')) break
      entries.push(line)
    }
  }
  if (entries.length === 0) problems.push('secret has no stringData entries')
  for (const entry of entries) {
    if (!/^  [A-Z0-9_]+: (""|'')$/.test(entry)) problems.push(`secret value not empty: ${entry.trim()}`)
  }
  if (!entries.some(entry => entry.startsWith('  SUPERAGENT_CLAUDE_GITHUB_TOKEN:'))) {
    problems.push('SUPERAGENT_CLAUDE_GITHUB_TOKEN missing from secret')
  }

  const pvc = docs.find(doc => kindOf(doc) === 'PersistentVolumeClaim') ?? ''
  if (!/- ReadWriteOnce/.test(pvc)) problems.push('PVC is not ReadWriteOnce')

  const configMap = docs.find(doc => kindOf(doc) === 'ConfigMap') ?? ''
  if (!configMap.includes('superagent-claude.json: |')) problems.push('ConfigMap lacks superagent-claude.json')
  if (!configMap.includes('"weakerNestedSandbox": true')) problems.push('ConfigMap lacks weakerNestedSandbox')

  return problems
}

describe('deploy/k8s/superagent-claude.yaml', () => {
  it('the manifest has no problems', () => {
    expect(manifestProblems(manifest)).toEqual([])
  })

  it('detects each violation', () => {
    const violations: [string, string][] = [
      ['  replicas: 1\n', '  replicas: 2\n'],
      ['type: Recreate', 'type: RollingUpdate'],
      ['runAsUser: 10001', 'runAsUser: 0'],
      ['allowPrivilegeEscalation: false', 'allowPrivilegeEscalation: false\n            privileged: true'],
      ['type: RuntimeDefault', 'type: Unconfined'],
      ['SUPERAGENT_CLAUDE_GITHUB_TOKEN: ""', 'SUPERAGENT_CLAUDE_GITHUB_TOKEN: "not-empty"'],
      ['terminationGracePeriodSeconds: 30', 'terminationGracePeriodSeconds: 5'],
      ['drop: ["ALL"]', 'drop: []'],
      ['periodSeconds: 10', 'periodSeconds: 5'],
      ['- ReadWriteOnce', '- ReadWriteMany'],
      ['automountServiceAccountToken: false', 'automountServiceAccountToken: true'],
    ]
    for (const [from, to] of violations) {
      const bad = manifest.replace(from, to)
      expect(bad, `${from} -> ${to}`).not.toBe(manifest)
      expect(manifestProblems(bad).length, `${from} -> ${to}`).toBeGreaterThan(0)
    }
  })

  it('the pod runs as the image user', () => {
    const [, uid, gid] = dockerfile.match(/^USER (\d+):(\d+)$/m) ?? []
    expect(uid).toBeDefined()
    expect(manifest).toMatch(new RegExp(`runAsUser: ${uid}$`, 'm'))
    expect(manifest).toMatch(new RegExp(`runAsGroup: ${gid}$`, 'm'))
    expect(manifest).toMatch(new RegExp(`fsGroup: ${gid}$`, 'm'))
  })

  it('deploy.md contains the manifest verbatim', () => {
    const blocks = [...deploy.matchAll(/^```yaml\n([\s\S]*?)^```$/gm)].map(m => m[1])
    expect(blocks).toContain(manifest)
  })
})

describe('docs/deploy.md Kubernetes section', () => {
  it('has the Kubernetes section', () => {
    for (const text of [
      '## Kubernetes',
      'kubectl create secret generic superagent-claude',
      "-l 'app.kubernetes.io/component!=credentials'",
      'ReadWriteOnce',
      'replicas: 1',
      'strategy: Recreate',
      'exits with code 2',
      'superagent-claude health --ready',
      'superagent-claude health --live',
      '60 seconds',
      'terminationGracePeriodSeconds: 30',
      'at most 10 seconds',
      'within 15 seconds',
      '--log-format json',
      'SUPERAGENT_CLAUDE_LOG_FORMAT=json',
      '[redacted]',
      'RuntimeDefault',
      'weakerNestedSandbox',
      'Localhost',
      'allowUnsandboxed',
      'NetworkPolicy',
    ]) {
      expect(deploy, text).toContain(text)
    }
  })

  it('recommends no full privilege and no Unconfined profile', () => {
    const start = deploy.indexOf('## Kubernetes')
    const rest = deploy.slice(start + '## Kubernetes'.length)
    const next = rest.search(/^## /m)
    const section = `## Kubernetes${next === -1 ? rest : rest.slice(0, next)}`.replace(/^```yaml\n[\s\S]*?^```$/gm, '')

    expect(section).not.toMatch(
      /--privileged|privileged:\s*true|type:\s*Unconfined|seccomp=unconfined|apparmor=unconfined|enforce:\s*privileged/i,
    )
    for (const line of section.split('\n')) {
      if (/unconfined/i.test(line)) {
        expect(/rejected|not recommended/.test(line), line).toBe(true)
      }
    }
    expect(deploy).not.toMatch(/\bM\d+\b|milestone|\.docs\//i)
  })
})
