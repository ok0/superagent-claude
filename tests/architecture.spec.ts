// Enforces the layer import rules, and that the bypass permission mode is never named under src/.
// core stays free of Node I/O and the SDK; policy imports only zod, core and itself; the executor imports only
// core, infra, app effects and store; runtimes import only the runtime contract and infra; the SDK is imported only
// from src/runtimes/claude; app and infra import only node:*, zod, proper-lockfile and allowed relative paths; the
// Source framework imports only core, policy, infra, itself and the app store and KV types (never the executor,
// runtimes or the SDK); the CLI imports only src/ modules, package.json and node:*.
import { describe, it, expect, afterEach } from 'vitest'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NON_LITERAL = '<non-literal>'

type RuleId = 'core' | 'policy' | 'app' | 'infra' | 'executor' | 'runtimes' | 'sources' | 'cli' | 'sdk'
type Violation = { file: string; specifier: string; rule: RuleId }

const SDK = '@anthropic-ai/claude-agent-sdk'
const external = (s: string): boolean => s.startsWith('node:') || s === 'zod' || s === 'proper-lockfile'

function textOf(n: ts.Node | undefined): string {
  return n && ts.isStringLiteralLike(n) ? n.text : NON_LITERAL
}

function importsOf(file: string, source: string): string[] {
  const sf = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      out.push(textOf(n.moduleSpecifier))
    } else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
      out.push(textOf(n.moduleReference.expression))
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(textOf(n.arguments[0]))
    } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require') {
      out.push(textOf(n.arguments[0]))
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument)) {
      out.push(textOf(n.argument.literal))
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

function resolves(file: string, spec: string): string {
  return posix.normalize(posix.join(posix.dirname(file), spec))
}

function checkFile(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  for (const spec of importsOf(file, source)) {
    const rel = spec.startsWith('./') || spec.startsWith('../')
    if (file.startsWith('src/core/')) {
      const allowed = spec === 'zod' || spec === 'node:crypto' || (rel && resolves(file, spec).startsWith('src/core/'))
      if (!allowed) violations.push({ file, specifier: spec, rule: 'core' })
    }
    if (file.startsWith('src/policy/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = spec === 'zod' || (rel && (r.startsWith('src/policy/') || r.startsWith('src/core/')))
      if (!allowed) violations.push({ file, specifier: spec, rule: 'policy' })
    }
    if (file.startsWith('src/infra/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel ? r.startsWith('src/infra/') || r.startsWith('src/core/') : external(spec)
      if (!allowed) violations.push({ file, specifier: spec, rule: 'infra' })
    }
    if (file.startsWith('src/app/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel ? r.startsWith('src/') && !r.startsWith('src/cli/') : external(spec)
      if (!allowed) violations.push({ file, specifier: spec, rule: 'app' })
    }
    if (file.startsWith('src/executor/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel
        ? r.startsWith('src/core/') ||
          r.startsWith('src/executor/') ||
          r.startsWith('src/infra/') ||
          r === 'src/app/effects.ts' ||
          r === 'src/app/store.ts'
        : spec.startsWith('node:') || spec === 'zod'
      if (!allowed) violations.push({ file, specifier: spec, rule: 'executor' })
    }
    if (file.startsWith('src/runtimes/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel
        ? r.startsWith('src/runtimes/') || r === 'src/executor/contract.ts' || r.startsWith('src/infra/')
        : spec.startsWith('node:') || spec === 'zod' || spec === SDK || spec.startsWith(SDK + '/')
      if (!allowed) violations.push({ file, specifier: spec, rule: 'runtimes' })
    }
    if (file.startsWith('src/sources/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel
        ? r.startsWith('src/core/') ||
          r.startsWith('src/policy/') ||
          r.startsWith('src/infra/') ||
          r.startsWith('src/sources/') ||
          r === 'src/app/kv.ts' ||
          r === 'src/app/store.ts'
        : spec.startsWith('node:') || spec === 'zod'
      if (!allowed) violations.push({ file, specifier: spec, rule: 'sources' })
    }
    if (file.startsWith('src/cli/')) {
      const r = rel ? resolves(file, spec) : ''
      const allowed = rel
        ? (r.startsWith('src/') && !r.startsWith('src/runtimes/claude/')) || r === 'package.json'
        : spec.startsWith('node:')
      if (!allowed) violations.push({ file, specifier: spec, rule: 'cli' })
    }
    if ((spec === SDK || spec.startsWith(SDK + '/')) && !file.startsWith('src/runtimes/claude/')) {
      violations.push({ file, specifier: spec, rule: 'sdk' })
    }
  }
  return violations
}

function scan(root: string): { files: string[]; violations: Violation[] } {
  if (!existsSync(join(root, 'src'))) return { files: [], violations: [] }
  const files = (readdirSync(join(root, 'src'), { recursive: true }) as string[])
    .filter(name => /\.(ts|tsx|mts|cts)$/.test(name))
    .map(name => 'src/' + name.split('\\').join('/'))
    .sort()
  const violations = files.flatMap(f => checkFile(f, readFileSync(join(root, f), 'utf8')))
  return { files, violations }
}

describe('importsOf', () => {
  it('finds static, re-export, dynamic, require, import-equals and import-type specifiers', () => {
    const src =
      "import a from 'a'\nexport { b } from 'b'\nawait import('c')\nconst d = require('d')\nimport e = require('e')\ntype F = import('f').F\nawait import(name)"
    expect(importsOf('src/core/x.ts', src)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', NON_LITERAL])
  })

  it('ignores import text in comments, strings and methods named require', () => {
    const src =
      "// import fs from 'node:fs'\n/* require('node:fs') */\nconst s = \"import('node:fs')\"\nclass P { require(id: string) { return id } run() { return this.require('x') } }"
    expect(importsOf('src/core/x.ts', src)).toEqual([])
  })
})

describe('core rule', () => {
  it.each([
    ["import fs from 'node:fs'", 'node:fs'],
    ["const m = await import('node:fs')", 'node:fs'],
    ["const fs = require('node:fs')", 'node:fs'],
    ["import { join } from 'node:path'", 'node:path'],
    ["import { run } from '../cli/main.ts'", '../cli/main.ts'],
    ["import _ from 'lodash'", 'lodash'],
    ["import { DatabaseSync } from 'node:sqlite'", 'node:sqlite'],
    ["import { lockSync } from 'proper-lockfile'", 'proper-lockfile'],
    ['const m = await import(name)', NON_LITERAL],
  ])('flags %s', (src, specifier) => {
    expect(checkFile('src/core/sample.ts', src)).toContainEqual({ file: 'src/core/sample.ts', specifier, rule: 'core' })
  })

  it('passes a sample with only allowed imports', () => {
    const src =
      "import { a } from './model.ts'\nimport type { B } from './ports.ts'\nexport * from './stage.ts'\nimport { z } from 'zod'\nimport { createHash } from 'node:crypto'\ntype T = import('./model.ts').Ticket"
    expect(checkFile('src/core/sample.ts', src)).toEqual([])
  })
})

describe('policy rule', () => {
  it('flags node:fs in src/policy', () => {
    expect(checkFile('src/policy/policy.ts', "import fs from 'node:fs'")).toEqual([
      { file: 'src/policy/policy.ts', specifier: 'node:fs', rule: 'policy' },
    ])
  })

  it('flags node:sqlite in src/policy', () => {
    expect(checkFile('src/policy/policy.ts', "import { DatabaseSync } from 'node:sqlite'")).toEqual([
      { file: 'src/policy/policy.ts', specifier: 'node:sqlite', rule: 'policy' },
    ])
  })

  it('allows core, sibling and zod imports', () => {
    const src = "import { M } from '../core/model.ts'\nimport { A } from './admission.ts'\nimport { z } from 'zod'"
    expect(checkFile('src/policy/policy.ts', src)).toEqual([])
  })

  it('flags node:crypto in src/policy', () => {
    expect(checkFile('src/policy/policy.ts', "import { createHash } from 'node:crypto'")).toEqual([
      { file: 'src/policy/policy.ts', specifier: 'node:crypto', rule: 'policy' },
    ])
  })

  it('flags relative imports into infra', () => {
    expect(checkFile('src/policy/policy.ts', "import { sameName } from '../infra/text.ts'").map(v => v.rule)).toEqual([
      'policy',
    ])
  })

  it('flags relative imports outside policy and core', () => {
    const v = checkFile('src/policy/policy.ts', "import x from '../app/store.ts'")
    expect(v.map(x => x.rule)).toContain('policy')
  })
})

describe('app and infra rules', () => {
  it('allows node builtins, zod, proper-lockfile, core, policy, infra and app relative imports in src/app', () => {
    const src =
      "import { DatabaseSync, type SQLInputValue } from 'node:sqlite'\nimport { mkdirSync } from 'node:fs'\nimport { z } from 'zod'\nimport { lockSync } from 'proper-lockfile'\nimport { A } from '../core/index.ts'\nimport { P } from '../policy/policy.ts'\nimport { H } from '../infra/health.ts'\nimport { K } from './kv.ts'"
    expect(checkFile('src/app/store.ts', src)).toEqual([])
  })

  it('flags a third-party package in src/app', () => {
    expect(checkFile('src/app/x.ts', "import _ from 'lodash'").map(v => v.rule)).toEqual(['app'])
  })

  it('flags the SDK in src/app as app and sdk', () => {
    expect(
      checkFile('src/app/x.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['app', 'sdk'])
  })

  it('flags relative imports into src/cli from src/app', () => {
    expect(checkFile('src/app/x.ts', "import { run } from '../cli/main.ts'").map(v => v.rule)).toEqual(['app'])
  })

  it('allows node builtins, core and sibling imports in src/infra', () => {
    const src =
      "import { readFileSync } from 'node:fs'\nimport { M } from '../core/model.ts'\nimport { fill } from './text.ts'"
    expect(checkFile('src/infra/x.ts', src)).toEqual([])
  })

  it('flags relative imports into src/app and third-party packages from src/infra', () => {
    expect(checkFile('src/infra/x.ts', "import { S } from '../app/store.ts'").map(v => v.rule)).toEqual(['infra'])
    expect(checkFile('src/infra/x.ts', "import _ from 'lodash'").map(v => v.rule)).toEqual(['infra'])
  })
})

describe('sdk rule', () => {
  it('flags the SDK in src/core', () => {
    expect(checkFile('src/core/x.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'")).toContainEqual({
      file: 'src/core/x.ts',
      specifier: SDK,
      rule: 'sdk',
    })
  })

  it('flags the SDK outside src/runtimes/claude', () => {
    expect(
      checkFile('src/sources/x.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['sources', 'sdk'])
  })

  it('allows the SDK in src/runtimes/claude', () => {
    expect(
      checkFile('src/runtimes/claude/adapter.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'"),
    ).toEqual([])
  })

  it('flags the SDK in src/policy', () => {
    expect(
      checkFile('src/policy/x.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['policy', 'sdk'])
  })

  it('flags the SDK in src/app/tools', () => {
    expect(
      checkFile('src/app/tools/executor.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['app', 'sdk'])
  })

  it('allows the SDK in every file of src/runtimes/claude', () => {
    expect(
      checkFile('src/runtimes/claude/options.ts', "import type { Options } from '@anthropic-ai/claude-agent-sdk'"),
    ).toEqual([])
  })
})

describe('permission mode', () => {
  const bypassNeedle = 'bypass' + 'Permissions'
  const skipNeedle = 'allowDangerously' + 'SkipPermissions'
  const names = (source: string): boolean => source.includes(bypassNeedle) || source.includes(skipNeedle)

  it('no source under src/ names the bypass permission mode', () => {
    const offenders = scan(ROOT).files.filter(f => names(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('detects the bypass permission mode in a sample source', () => {
    expect(names("permissionMode: 'bypass" + "Permissions'")).toBe(true)
  })
})

describe('executor and runtimes rules', () => {
  it('flags the SDK in src/executor as executor and sdk', () => {
    expect(
      checkFile('src/executor/worker-executor.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(
        v => v.rule,
      ),
    ).toEqual(['executor', 'sdk'])
  })

  it('flags a runtime implementation imported into src/executor', () => {
    expect(
      checkFile('src/executor/worker-executor.ts', "import { FakeRuntime } from '../runtimes/fake/runtime.ts'").map(
        v => v.rule,
      ),
    ).toEqual(['executor'])
  })

  it('flags app modules other than effects and store, and other packages, in src/executor', () => {
    expect(checkFile('src/executor/x.ts', "import { o } from '../app/outbox.ts'").map(v => v.rule)).toEqual([
      'executor',
    ])
    expect(checkFile('src/executor/x.ts', "import _ from 'lodash'").map(v => v.rule)).toEqual(['executor'])
    expect(checkFile('src/executor/x.ts', "import { lockSync } from 'proper-lockfile'").map(v => v.rule)).toEqual([
      'executor',
    ])
  })

  it('allows core, infra, app effects and store, sibling, zod and node imports in src/executor', () => {
    const src =
      "import { C } from '../core/index.ts'\nimport { H } from '../infra/health.ts'\nimport { E } from '../app/effects.ts'\nimport { S } from '../app/store.ts'\nimport { R } from './contract.ts'\nimport { z } from 'zod'\nimport { join } from 'node:path'"
    expect(checkFile('src/executor/x.ts', src)).toEqual([])
  })

  it('allows only the runtime contract and infra from src/runtimes', () => {
    expect(
      checkFile('src/runtimes/fake/runtime.ts', "import type { AgentRuntime } from '../../executor/contract.ts'"),
    ).toEqual([])
    expect(
      checkFile('src/runtimes/fake/runtime.ts', "import { W } from '../../executor/worker-executor.ts'").map(
        v => v.rule,
      ),
    ).toEqual(['runtimes'])
    expect(
      checkFile('src/runtimes/fake/runtime.ts', "import { S } from '../../app/store.ts'").map(v => v.rule),
    ).toEqual(['runtimes'])
  })

  it('flags the SDK in src/runtimes/fake only through the sdk rule', () => {
    expect(
      checkFile('src/runtimes/fake/runtime.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(
        v => v.rule,
      ),
    ).toEqual(['sdk'])
  })
})

describe('sources and cli rules', () => {
  it.each([
    "import { WorkerExecutor } from '../executor/worker-executor.ts'",
    "import { FakeRuntime } from '../runtimes/fake/runtime.ts'",
    "import { Runtime } from '../app/runtime.ts'",
    "import { Outbox } from '../app/outbox.ts'",
    "import { run } from '../cli/main.ts'",
    "import _ from 'lodash'",
  ])('flags %s in src/sources as sources', src => {
    expect(checkFile('src/sources/registry.ts', src).map(v => v.rule)).toContain('sources')
  })

  it.each([
    "import { WorkerExecutor } from '../../executor/worker-executor.ts'",
    "import { FakeRuntime } from '../../runtimes/fake/runtime.ts'",
    "import { Runtime } from '../../app/runtime.ts'",
    "import { query } from '@anthropic-ai/claude-agent-sdk'",
  ])('flags %s in src/sources/github as sources', src => {
    expect(checkFile('src/sources/github/source.ts', src).map(v => v.rule)).toContain('sources')
  })

  it('allows core, policy, infra, sources, app store and KV, zod and node imports in src/sources/github', () => {
    const src =
      "import { C } from '../../core/index.ts'\nimport { P } from '../../policy/actors.ts'\nimport { H } from '../../infra/commands.ts'\nimport { K } from '../kind.ts'\nimport { T } from './trigger.ts'\nimport { S } from '../../app/store.ts'\nimport { V } from '../../app/kv.ts'\nimport { z } from 'zod'\nimport { setTimeout } from 'node:timers'"
    expect(checkFile('src/sources/github/source.ts', src)).toEqual([])
  })

  it('flags the SDK in src/sources as sources and sdk', () => {
    expect(
      checkFile('src/sources/registry.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['sources', 'sdk'])
  })

  it('allows core, policy, infra, sibling, app store and KV, zod and node imports in src/sources', () => {
    const src =
      "import { C } from '../core/index.ts'\nimport { P } from '../policy/actors.ts'\nimport { H } from '../infra/health.ts'\nimport { K } from './kind.ts'\nimport { S } from '../app/store.ts'\nimport { V } from '../app/kv.ts'\nimport { z } from 'zod'\nimport { setTimeout } from 'node:timers'"
    expect(checkFile('src/sources/registry.ts', src)).toEqual([])
  })

  it('allows app, runtimes/fake, package.json and node imports in src/cli, and flags others', () => {
    const src =
      "import pkg from '../../package.json' with { type: 'json' }\nimport { Runtime } from '../app/runtime.ts'\nimport { FakeRuntime } from '../runtimes/fake/runtime.ts'\nimport { resolve } from 'node:path'"
    expect(checkFile('src/cli/main.ts', src)).toEqual([])
    expect(checkFile('src/cli/main.ts', "import _ from 'lodash'").map(v => v.rule)).toEqual(['cli'])
    expect(
      checkFile('src/cli/main.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'").map(v => v.rule),
    ).toEqual(['cli', 'sdk'])
    expect(checkFile('src/cli/main.ts', "import { A } from '../runtimes/claude/runtime.ts'").map(v => v.rule)).toEqual([
      'cli',
    ])
  })

  it('allows the app agent factory to import the Claude runtime and the CLI to import it', () => {
    expect(checkFile('src/app/agent.ts', "import { ClaudeRuntime } from '../runtimes/claude/runtime.ts'")).toEqual([])
    expect(checkFile('src/cli/main.ts', "import { createAgent } from '../app/agent.ts'")).toEqual([])
  })
})

describe('scan', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const tempRoot = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'arch-'))
    dirs.push(dir)
    return dir
  }

  it('detects a violation in a temp tree; absent policy/runtimes dirs pass', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'src', 'core'), { recursive: true })
    writeFileSync(join(root, 'src', 'core', 'a.ts'), "import fs from 'node:fs'\n")
    writeFileSync(join(root, 'src', 'core', 'b.ts'), "import { a } from './a.ts'\n")
    const r = scan(root)
    expect(r.files).toEqual(['src/core/a.ts', 'src/core/b.ts'])
    expect(r.violations).toEqual([{ file: 'src/core/a.ts', specifier: 'node:fs', rule: 'core' }])
  })

  it('detects an SDK import injected into src/executor in a temp tree', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'src', 'executor'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'executor', 'sample.ts'),
      "import { query } from '@anthropic-ai/claude-agent-sdk'\n",
    )
    expect(scan(root).violations).toEqual([
      { file: 'src/executor/sample.ts', specifier: SDK, rule: 'executor' },
      { file: 'src/executor/sample.ts', specifier: SDK, rule: 'sdk' },
    ])
  })

  it('detects an executor import injected into src/sources in a temp tree', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'src', 'sources'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'sources', 'sample.ts'),
      "import { WorkerExecutor } from '../executor/worker-executor.ts'\n",
    )
    expect(scan(root).violations).toEqual([
      { file: 'src/sources/sample.ts', specifier: '../executor/worker-executor.ts', rule: 'sources' },
    ])
  })

  it('detects a runtimes import injected into src/sources/github in a temp tree', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'src', 'sources', 'github'), { recursive: true })
    writeFileSync(
      join(root, 'src', 'sources', 'github', 'sample.ts'),
      "import { FakeRuntime } from '../../runtimes/fake/runtime.ts'\n",
    )
    expect(scan(root).violations).toEqual([
      { file: 'src/sources/github/sample.ts', specifier: '../../runtimes/fake/runtime.ts', rule: 'sources' },
    ])
  })

  it('returns nothing when src is absent', () => {
    expect(scan(tempRoot())).toEqual({ files: [], violations: [] })
  })

  it('the repository src tree has no violations', () => {
    const r = scan(ROOT)
    expect(r.violations).toEqual([])
    for (const p of [
      'src/executor/contract.ts',
      'src/executor/recovery.ts',
      'src/executor/slots.ts',
      'src/executor/worker-executor.ts',
      'src/executor/worker-store.ts',
      'src/runtimes/fake/runtime.ts',
    ])
      expect(r.files).toContain(p)
    for (const p of [
      'src/core/assignments.ts',
      'src/core/engine.ts',
      'src/core/errors.ts',
      'src/core/evals.ts',
      'src/core/ids.ts',
      'src/core/index.ts',
      'src/core/intake.ts',
      'src/core/memory.ts',
      'src/core/model.ts',
      'src/core/part.ts',
      'src/core/ports.ts',
      'src/core/reasons.ts',
      'src/core/replies.ts',
      'src/core/stage.ts',
      'src/core/tickets.ts',
    ]) {
      expect(r.files).toContain(p)
    }
    for (const p of ['src/policy/actors.ts', 'src/policy/admission.ts', 'src/policy/limits.ts', 'src/policy/policy.ts'])
      expect(r.files).toContain(p)
    expect(r.files.filter(f => f.startsWith('src/policy/')).length).toBeGreaterThanOrEqual(4)
    for (const p of [
      'src/app/cache.ts',
      'src/app/effects.ts',
      'src/app/kv.ts',
      'src/app/outbox.ts',
      'src/app/passes.ts',
      'src/app/store.ts',
      'src/app/store-read.ts',
      'src/app/versions.ts',
      'src/infra/health.ts',
      'src/infra/paths.ts',
      'src/infra/text.ts',
    ])
      expect(r.files).toContain(p)
    expect(r.files).not.toContain('src/app/migration.ts')
    for (const p of [
      'src/sources/admission-context.ts',
      'src/sources/host.ts',
      'src/sources/kind.ts',
      'src/sources/poll.ts',
      'src/sources/registry.ts',
      'src/app/config.ts',
      'src/app/runtime.ts',
      'src/cli/bin.ts',
      'src/cli/main.ts',
      'src/sources/github/trigger.ts',
      'src/sources/github/read.ts',
      'src/sources/github/pull.ts',
      'src/sources/github/channel.ts',
      'src/sources/github/source.ts',
      'src/infra/commands.ts',
      'src/infra/env.ts',
      'src/app/sources.ts',
      'src/app/credentials.ts',
      'src/sources/admission-filter.ts',
    ])
      expect(r.files).toContain(p)
  })

  it('allows the auth constants import from the Claude runtime options into app/credentials only as code, never the SDK', () => {
    expect(
      checkFile('src/app/credentials.ts', "import { AUTH_ENV, type AuthMode } from '../runtimes/claude/options.ts'\n"),
    ).toEqual([])
    expect(
      checkFile('src/app/credentials.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'\n").map(v => v.rule),
    ).toContain('sdk')
    expect(
      checkFile('src/sources/admission-filter.ts', "import { Runtime } from '../app/runtime.ts'\n").map(v => v.rule),
    ).toContain('sources')
  })
})

describe('vendor names', () => {
  it('core and policy never name the hosting service', () => {
    const offenders = scan(ROOT)
      .files.filter(f => f.startsWith('src/core/') || f.startsWith('src/policy/'))
      .filter(f => /github/i.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('the executor never names the hosting service', () => {
    const offenders = scan(ROOT)
      .files.filter(f => f.startsWith('src/executor/'))
      .filter(f => /github/i.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('outside its Source plugin only the assembly point, the Router/worker tool layer (resources, thread keys, read function, cards and notices) and the runtime env secret filter name the hosting service', () => {
    const offenders = scan(ROOT)
      .files.filter(f => !f.startsWith('src/sources/github/'))
      .filter(f =>
        readFileSync(join(ROOT, f), 'utf8')
          .split('\n')
          .some(line => !line.includes('dsh-superagent-prototype') && /github/i.test(line)),
      )
    expect(offenders).toEqual([
      'src/app/assessment.ts',
      'src/app/notices.ts',
      'src/app/prompts.ts',
      'src/app/resources.ts',
      'src/app/runtime.ts',
      'src/app/sources.ts',
      'src/app/tools/delivery.ts',
      'src/app/tools/executor.ts',
      'src/app/tools/main.ts',
      'src/runtimes/claude/options.ts',
    ])
  })

  it('the Source framework names no service or host framework outside its port header', () => {
    const offenders = ['kind', 'host', 'registry', 'poll', 'admission-context', 'admission-filter']
      .map(n => `src/sources/${n}.ts`)
      .flatMap(f =>
        readFileSync(join(ROOT, f), 'utf8')
          .split('\n')
          .filter(line => !line.includes('dsh-superagent-prototype') && /github|feishu|lark|cordis/i.test(line))
          .map(line => `${f}: ${line}`),
      )
    expect(offenders).toEqual([])
  })
})
