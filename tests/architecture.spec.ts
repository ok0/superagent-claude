// Enforces the layer import rules (PAC1): core stays free of Node I/O and the SDK, policy stays inside core, and the SDK is imported only from src/runtimes/claude.
import { describe, it, expect, afterEach } from 'vitest'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NON_LITERAL = '<non-literal>'

type RuleId = 'core' | 'policy' | 'sdk'
type Violation = { file: string; specifier: string; rule: RuleId }

const SDK = '@anthropic-ai/claude-agent-sdk'

function textOf(n: ts.Node | undefined): string {
  return n && ts.isStringLiteralLike(n) ? n.text : NON_LITERAL
}

function importsOf(file: string, source: string): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
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
      const allowed = spec === 'zod' || spec === 'node:crypto' || (rel && (r.startsWith('src/policy/') || r.startsWith('src/core/')))
      if (!allowed) violations.push({ file, specifier: spec, rule: 'policy' })
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
    .filter((name) => /\.(ts|tsx|mts|cts)$/.test(name))
    .map((name) => 'src/' + name.split('\\').join('/'))
    .sort()
  const violations = files.flatMap((f) => checkFile(f, readFileSync(join(root, f), 'utf8')))
  return { files, violations }
}

describe('importsOf', () => {
  it('finds static, re-export, dynamic, require, import-equals and import-type specifiers', () => {
    const src = "import a from 'a'\nexport { b } from 'b'\nawait import('c')\nconst d = require('d')\nimport e = require('e')\ntype F = import('f').F\nawait import(name)"
    expect(importsOf('src/core/x.ts', src)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', NON_LITERAL])
  })

  it('ignores import text in comments, strings and methods named require', () => {
    const src = "// import fs from 'node:fs'\n/* require('node:fs') */\nconst s = \"import('node:fs')\"\nclass P { require(id: string) { return id } run() { return this.require('x') } }"
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
    ['const m = await import(name)', NON_LITERAL],
  ])('flags %s', (src, specifier) => {
    expect(checkFile('src/core/sample.ts', src)).toContainEqual({ file: 'src/core/sample.ts', specifier, rule: 'core' })
  })

  it('passes a sample with only allowed imports', () => {
    const src = "import { a } from './model.ts'\nimport type { B } from './ports.ts'\nexport * from './stage.ts'\nimport { z } from 'zod'\nimport { createHash } from 'node:crypto'\ntype T = import('./model.ts').Ticket"
    expect(checkFile('src/core/sample.ts', src)).toEqual([])
  })
})

describe('policy rule', () => {
  it('flags node:fs in src/policy', () => {
    expect(checkFile('src/policy/policy.ts', "import fs from 'node:fs'")).toEqual([{ file: 'src/policy/policy.ts', specifier: 'node:fs', rule: 'policy' }])
  })

  it('allows core, sibling, zod and node:crypto imports', () => {
    const src = "import { M } from '../core/model.ts'\nimport { A } from './admission.ts'\nimport { z } from 'zod'\nimport { createHash } from 'node:crypto'"
    expect(checkFile('src/policy/policy.ts', src)).toEqual([])
  })

  it('flags relative imports outside policy and core', () => {
    const v = checkFile('src/policy/policy.ts', "import x from '../app/store.ts'")
    expect(v.map((x) => x.rule)).toContain('policy')
  })
})

describe('sdk rule', () => {
  it('flags the SDK in src/core', () => {
    expect(checkFile('src/core/x.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'")).toContainEqual({ file: 'src/core/x.ts', specifier: SDK, rule: 'sdk' })
  })

  it('flags the SDK outside src/runtimes/claude', () => {
    expect(checkFile('src/executor/worker.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'")).toEqual([{ file: 'src/executor/worker.ts', specifier: SDK, rule: 'sdk' }])
  })

  it('allows the SDK in src/runtimes/claude', () => {
    expect(checkFile('src/runtimes/claude/adapter.ts', "import { query } from '@anthropic-ai/claude-agent-sdk'")).toEqual([])
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

  it('returns nothing when src is absent', () => {
    expect(scan(tempRoot())).toEqual({ files: [], violations: [] })
  })

  it('the repository src tree has no violations', () => {
    const r = scan(ROOT)
    expect(r.violations).toEqual([])
    for (const p of ['src/core/errors.ts', 'src/core/ids.ts', 'src/core/index.ts', 'src/core/memory.ts', 'src/core/model.ts', 'src/core/part.ts', 'src/core/ports.ts', 'src/core/reasons.ts', 'src/core/stage.ts']) {
      expect(r.files).toContain(p)
    }
  })
})
