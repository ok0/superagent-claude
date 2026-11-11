import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { checkDiff, contentProblems, pullPatch } from './live/rules.ts'
import type { DiffFile } from './live/rules.ts'
import { FIXTURES_DIR, SEED_DIR, npmCi, runCommand, runHidden, type Install } from './live/hidden.ts'
import { judgeAmbiguity, isQuestionLine, questionLines, waitForPull } from './live/ambiguity.ts'
import type { IssueComment } from './live/ambiguity.ts'
import { judgeScenario, loadAllScenarios, loadScenarios, scenarioFlows, scenarioProblems } from './live/scenarios.ts'
import type { LiveScenario } from './live/scenarios.ts'
import { loadSeed } from './live/seed-playground.ts'
import { EXAMPLE_TARGET } from './fixtures/live-target.ts'

const HIDDEN = 600_000
const REFERENCE = join(FIXTURES_DIR, 'playground-reference')
const UI = 'ui-overdue-rows'
const POLISH = 'ui-polish-list'
const AGENT = EXAMPLE_TARGET.agentLogin

const dirs: string[] = []
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'live-ui-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const copySeed = (dir: string, overlay?: string): void => {
  cpSync(SEED_DIR, dir, { recursive: true, filter: s => !s.split(sep).includes('node_modules') })
  if (overlay !== undefined) cpSync(join(REFERENCE, overlay), dir, { recursive: true })
}

const byId = (scenarios: readonly LiveScenario[], id: string): LiveScenario => {
  const found = scenarios.find(s => s.id === id)
  if (!found) throw new Error('missing scenario ' + id)
  return found
}

const uiScenario = async (id: string): Promise<LiveScenario> => byId(await loadAllScenarios(), id)

const pullAt = (created_at: string): { number: number; created_at: string; head: { ref: string } } => ({ number: 3, created_at, head: { ref: 'agent/ui' } })

const agentComment = (body: string, created_at: string, login = AGENT): IssueComment => ({ user: { login }, body, created_at })

const HIDDEN_DIR = (scenario: LiveScenario): string => join(FIXTURES_DIR, scenario.hidden?.dir ?? '')

const TZ_CASES = ['UTC', 'America/Adak', 'Asia/Kolkata'] as const

describe('UI scenarios', () => {
  it('core has the five scenarios', async () => {
    const core = await loadScenarios({})
    expect(core.map(s => s.id)).toEqual(['bug-paging', 'feature-partial-update', 'review-limit-validation', UI, POLISH])
    const g = byId(core, UI)
    const h = byId(core, POLISH)
    for (const s of [g, h]) {
      expect(s.tier).toBe('core')
      expect(scenarioProblems(s)).toEqual([])
      expect(contentProblems('title', s.issue.title)).toEqual([])
      expect(contentProblems('body', s.issue.body)).toEqual([])
      expect(contentProblems('answer', s.answer ?? '')).toEqual([])
      expect(s.issue.body.startsWith('@{{agent}} ')).toBe(true)
      expect((s.answer ?? '').startsWith('@{{agent}} ')).toBe(true)
    }
    expect(g.issue.body).not.toMatch(/\b(colou?r|red|icon|badge|bold|class|css)\b/i)
    expect(g.diff).toEqual({ requireSourceAndTest: true, allowedRoots: ['web/'], allowLockfile: false })
    expect(h.hidden).toBeUndefined()
    expect(h.diff.allowedRoots).toEqual(['web/'])
    expect(h.diff.requireSource).toBe(true)
    expect(scenarioFlows(core)).toHaveLength(4)
  })

  it('UI hidden files stay out of the playground', async () => {
    const g = await uiScenario(UI)
    const dir = resolve(FIXTURES_DIR, g.hidden?.dir ?? '')
    expect(existsSync(dir)).toBe(true)
    expect(dir.startsWith(SEED_DIR + sep)).toBe(false)
    for (const f of loadSeed(true)) {
      expect(f.path.startsWith('web/src/hidden-acceptance')).toBe(false)
      expect(f.path.includes('playground-hidden')).toBe(false)
      expect(f.path.includes('playground-reference')).toBe(false)
    }
  })

  it('diff rule for the overdue scenario', async () => {
    const g = await uiScenario(UI)
    const check = (files: DiffFile[]) => checkDiff(files, pullPatch(files), g.diff, { hiddenDest: g.hidden?.dest })
    const row: DiffFile = { filename: 'web/src/components/TaskRow.tsx', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }
    const test: DiffFile = { filename: 'web/src/components/TaskList.test.tsx', status: 'modified', patch: "@@ -1 +1 @@\n-  it('a', () => {})\n+  it('b', () => {})" }
    const api: DiffFile = { filename: 'api/src/main.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }
    const hidden: DiffFile = { filename: 'web/src/hidden-acceptance/x.test.tsx', status: 'added', patch: "@@ -0,0 +1 @@\n+it('x', () => {})" }
    expect(check([row, test])).toEqual({ pass: true, reasons: [] })
    expect(check([row, test, api]).reasons.join('\n')).toMatch(/outside allowed roots/)
    expect(check([row]).pass).toBe(false)
    expect(check([test]).pass).toBe(false)
    expect(check([row, test, hidden]).reasons.join('\n')).toMatch(/hidden test path changed/)
  })

  it('judgeAmbiguity counts an agent question or a stated interpretation', async () => {
    const pr = { body: 'Updated TaskRow.tsx and styles.css to space the rows.', createdAt: '2026-11-11T10:00:00Z' }
    const files = ['web/src/components/TaskRow.tsx', 'web/src/styles.css']
    const question = agentComment('Should the rows get more spacing?\n\n<!-- superagent-claude:x -->', '2026-11-11T09:00:00Z')

    expect(judgeAmbiguity([question], { body: 'Closes #3', createdAt: pr.createdAt }, files, AGENT)).toMatchObject({ passed: true, via: 'question' })

    const byMention = judgeAmbiguity([], pr, files, AGENT)
    expect(byMention).toMatchObject({ passed: true, via: 'interpretation' })
    expect(byMention.mentions).toEqual(['TaskRow', 'TaskRow.tsx', 'styles.css'])

    expect(judgeAmbiguity([question], pr, files, AGENT)).toMatchObject({ passed: true, via: 'question' })

    expect(judgeAmbiguity([], { body: 'Closes #3', createdAt: pr.createdAt }, files, AGENT)).toMatchObject({ passed: false, via: null })

    const late = agentComment('Should it be red?', '2026-11-11T11:00:00Z')
    expect(judgeAmbiguity([late], { body: 'Closes #3', createdAt: pr.createdAt }, files, AGENT).passed).toBe(false)

    const owner = agentComment('Which rows?', '2026-11-11T09:00:00Z', EXAMPLE_TARGET.ownerLogin)
    expect(judgeAmbiguity([owner], { body: 'Closes #3', createdAt: pr.createdAt }, files, AGENT).passed).toBe(false)

    const fenced = agentComment('```\nShould the rows get more spacing?\n```', '2026-11-11T09:00:00Z')
    expect(judgeAmbiguity([fenced], { body: 'Closes #3', createdAt: pr.createdAt }, files, AGENT).passed).toBe(false)
  })

  it('question lines are recognized', () => {
    for (const line of ['Which rows?', '어떤 방식이 좋을까요？', '이렇게 바꿔도 될까요.', '진행해도 괜찮나요', '확인해 주시겠습니까?', '**Is this ok?**']) {
      expect(isQuestionLine(line), line).toBe(true)
    }
    for (const line of ['Done.', '> quoted?', '<!-- superagent-claude:x -->', '']) {
      expect(isQuestionLine(line), line).toBe(false)
    }
  })

  it('judgeAmbiguity accepts the agent acknowledgement that states its interpretation', () => {
    const ACK = '진행합니다: 웹 앱 task 목록 화면을 한눈에 더 잘 들어오도록 다듬겠습니다.'
    const files = ['web/src/styles.css']
    const pr = { body: 'Closes #42', createdAt: '2026-11-11T04:23:49Z' }
    const created = '2026-11-11T04:23:48Z'
    for (const body of [ACK, `${ACK}\n\n<!-- superagent-claude:12fec983ad307a91c95694587d0a040e -->`]) {
      const verdict = judgeAmbiguity([agentComment(body, created)], pr, files, AGENT)
      expect(verdict).toMatchObject({ passed: true, via: 'interpretation', source: 'comment' })
      expect(verdict.statement).toContain('다듬겠습니다')
    }
    const question = agentComment('Should the rows get more spacing?', created)
    expect(judgeAmbiguity([question, agentComment(ACK, created)], pr, files, AGENT)).toMatchObject({ passed: true, via: 'question', statement: null })
    expect(judgeAmbiguity([agentComment(ACK, '2026-11-11T05:00:00Z')], pr, files, AGENT).passed).toBe(false)
    expect(judgeAmbiguity([agentComment(ACK, created, EXAMPLE_TARGET.ownerLogin)], pr, files, AGENT)).toMatchObject({ passed: false, via: null, source: null, statement: null })
    expect(judgeAmbiguity([agentComment('```\n' + ACK + '\n```', created)], pr, files, AGENT).passed).toBe(false)
    expect(judgeAmbiguity([agentComment('> ' + ACK, created)], pr, files, AGENT).passed).toBe(false)
    expect(judgeAmbiguity([agentComment('작업을 시작합니다.', created)], pr, files, AGENT).passed).toBe(false)
  })

  it('judgeAmbiguity accepts PR prose that states the change without naming a file', () => {
    // The live PR 47 body is the real text (read via GET from the playground repo); it names no file.
    const REAL_PR47_BODY = [
      'This is by an automated agent, not a human.',
      '',
      'Restyles the web task list so it is easier to scan (CSS only; no markup or behavior change):',
      '- Each task is a white card on a light gray page, with spacing between cards.',
      '- The title is bold and takes the free space; the badge and due date sit to its right, with a muted due date.',
      '- The page content is centered with a max width.',
      '- The empty state ("No tasks") has a dashed placeholder box.',
      '',
      'Verification: `npm run typecheck` passes; web tests pass (19/19). Root `npm test` fails here only in the api HTTP tests (`listen EPERM` — the agent sandbox blocks local port binding); the api workspace is untouched.',
      '',
      '**Visual evidence: missing.** Before/After screenshots could not be captured: the sandbox blocks local ports (mock API) and headless Chrome. Baseline is `52a1a7d`; changed revision is this branch. Please review visually before merging.',
      '',
      'Closes #39',
    ].join('\n')
    const files = ['web/src/styles.css']
    const createdAt = '2026-11-11T04:23:49Z'
    expect(judgeAmbiguity([], { body: REAL_PR47_BODY, createdAt }, files, AGENT)).toMatchObject({ passed: true, via: 'interpretation', source: 'pr-body', mentions: [] })
    expect(judgeAmbiguity([], { body: '작업 목록의 행 간격과 색상을 조정했습니다.', createdAt }, files, AGENT)).toMatchObject({ passed: true, via: 'interpretation', source: 'pr-body' })
    for (const body of ['', null, 'Closes #42', '## Summary\n\n## Test plan\n- [ ] npm test']) {
      expect(judgeAmbiguity([], { body, createdAt }, files, AGENT)).toMatchObject({ passed: false, via: null })
    }
  })

  it('waitForPull answers once and waits', async () => {
    const question = agentComment('Should the rows get more spacing?', '2026-11-11T09:00:00Z')
    const pull = pullAt('2026-11-11T10:00:00Z')
    let clock = 0
    const now = (): number => clock
    const sleep = async (): Promise<void> => {
      clock += 30_000
    }

    let poll = 0
    const sequence: IssueComment[][] = [[], [question], [question], [question]]
    const posted: string[] = []
    const answered = await waitForPull({
      answer: 'the answer',
      agent: AGENT,
      comments: async () => sequence[Math.min(poll - 1, sequence.length - 1)] ?? [],
      postAnswer: async body => {
        posted.push(body)
        return { html_url: 'https://github.com/example/comment/1' }
      },
      findPull: async () => (++poll >= 4 ? pull : undefined),
      timeoutMs: 600_000,
      stepMs: 30_000,
      sleep,
      now,
    })
    expect(posted).toEqual(['the answer'])
    expect(answered).toMatchObject({ asked: true, answerUrl: 'https://github.com/example/comment/1' })
    expect(answered.pull).toEqual(pull)

    let quietPosts = 0
    const quiet = await waitForPull({
      answer: 'the answer',
      agent: AGENT,
      comments: async () => [],
      postAnswer: async () => {
        quietPosts++
        return { html_url: 'x' }
      },
      findPull: async () => pull,
      timeoutMs: 600_000,
      stepMs: 30_000,
      sleep,
      now,
    })
    expect(quietPosts).toBe(0)
    expect(quiet).toMatchObject({ asked: false, answerUrl: null })

    let withoutAnswerPosts = 0
    const noAnswer = await waitForPull({
      agent: AGENT,
      comments: async () => [question],
      postAnswer: async () => {
        withoutAnswerPosts++
        return { html_url: 'x' }
      },
      findPull: async () => pull,
      timeoutMs: 600_000,
      stepMs: 30_000,
      sleep,
      now,
    })
    expect(withoutAnswerPosts).toBe(0)
    expect(noAnswer).toMatchObject({ asked: true, answerUrl: null })

    let timeoutPosts = 0
    await expect(
      waitForPull({
        answer: 'the answer',
        agent: AGENT,
        comments: async () => [question],
        postAnswer: async () => {
          timeoutPosts++
          return { html_url: 'x' }
        },
        findPull: async () => undefined,
        timeoutMs: 120_000,
        stepMs: 30_000,
        sleep,
        now,
      }),
    ).rejects.toThrow(/after the agent asked a question/)
    expect(timeoutPosts).toBe(1)
  })

  it('Korean clarification requests without a question mark are recognized', () => {
    const stalled = 'task 목록 화면은 "보기 좋게"라는 요청만으로는 목표 디자인이 정해지지 않아 변경하지 않았습니다. 원하는 결과(예: 간격, 정렬, 강조할 정보)를 구체적으로 알려 주시면 다시 진행하겠습니다.'
    for (const line of [stalled, '알려주세요.', '말씀해 주세요', '확인 부탁드립니다.', '확인해 주세요']) {
      expect(isQuestionLine(line), line).toBe(true)
    }
    for (const line of ['변경을 완료했습니다.', 'PR을 열었습니다: 알려진 이슈는 없습니다.', '> 알려 주시면 다시 진행하겠습니다.']) {
      expect(isQuestionLine(line), line).toBe(false)
    }
    expect(questionLines('```\n알려 주세요.\n```')).toEqual([])
    expect(questionLines('> 알려 주세요.')).toEqual([])
  })

  it('judgeAmbiguity counts a stalled clarification request before the pull request', () => {
    const stalled = agentComment('목표 디자인이 정해지지 않았습니다. 구체적으로 알려 주시면 다시 진행하겠습니다.', '2026-11-11T09:00:00Z')
    expect(judgeAmbiguity([stalled], { body: 'Closes #3', createdAt: '2026-11-11T10:00:00Z' }, [], AGENT)).toMatchObject({ passed: true, via: 'question' })
  })

  it('waitForPull posts the answer once for a stalled clarification request', async () => {
    const stalled = agentComment('목표 디자인이 정해지지 않았습니다. 구체적으로 알려 주시면 다시 진행하겠습니다.', '2026-11-11T09:00:00Z')
    const pull = pullAt('2026-11-11T10:00:00Z')
    let clock = 0
    const now = (): number => clock
    let poll = 0
    const posted: string[] = []
    const result = await waitForPull({
      answer: 'the answer',
      agent: AGENT,
      comments: async () => [stalled],
      postAnswer: async body => {
        posted.push(body)
        return { html_url: 'https://github.com/example/comment/2' }
      },
      findPull: async () => (++poll >= 4 ? pull : undefined),
      timeoutMs: 600_000,
      stepMs: 30_000,
      sleep: async () => {
        clock += 30_000
      },
      now,
    })
    expect(posted).toEqual(['the answer'])
    expect(result).toMatchObject({ asked: true, answerUrl: 'https://github.com/example/comment/2' })
  })

  it('waitForPull fails fast when the agent replies but opens no pull request', async () => {
    const question = agentComment('Should the rows get more spacing?', '2026-11-11T09:00:00Z')
    const other = agentComment('Which rows?', '2026-11-11T09:00:00Z', EXAMPLE_TARGET.ownerLogin)
    let clock = 0
    const now = (): number => clock
    let posts = 0
    await expect(
      waitForPull({
        answer: 'the answer',
        agent: AGENT,
        comments: async () => [other, question],
        postAnswer: async () => {
          posts++
          return { html_url: 'x' }
        },
        findPull: async () => undefined,
        timeoutMs: 10_000_000,
        stepMs: 30_000,
        sleep: async () => {
          clock += 30_000
        },
        now,
        graceMs: 120_000,
      }),
    ).rejects.toThrow(/opened no pull request/)
    expect(posts).toBe(1)
    expect(clock).toBeLessThanOrEqual(120_000 + 60_000)
  })

  it('waitForPull grace timer ignores other users and resolves when a pull request appears in time', async () => {
    const other = agentComment('Which rows?', '2026-11-11T09:00:00Z', EXAMPLE_TARGET.ownerLogin)
    const pull = pullAt('2026-11-11T10:00:00Z')
    let clock = 0
    const now = (): number => clock
    let poll = 0
    const result = await waitForPull({
      agent: AGENT,
      comments: async () => [other],
      postAnswer: async () => ({ html_url: 'x' }),
      findPull: async () => (++poll >= 10 ? pull : undefined),
      timeoutMs: 10_000_000,
      stepMs: 30_000,
      sleep: async () => {
        clock += 30_000
      },
      now,
      graceMs: 120_000,
    })
    expect(result).toMatchObject({ asked: false, answerUrl: null })
    expect(result.pull).toEqual(pull)
  })

  it('the (h) verdict truth table', async () => {
    const h = await uiScenario(POLISH)
    for (const checks of ['success', 'failure']) {
      for (const pass of [true, false]) {
        for (const ambiguity of [true, false]) {
          const verdict = judgeScenario(h, { checks, hidden: null, diff: { pass }, base: null, ambiguity: { passed: ambiguity } })
          const failed = [checks !== 'success' ? 'checks' : null, !pass ? 'diff' : null, !ambiguity ? 'ambiguity' : null].filter(Boolean)
          expect(verdict.passed).toBe(failed.length === 0)
          expect(verdict.failed).toEqual(failed)
        }
      }
    }
    const docs: DiffFile = { filename: 'web/README.md', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }
    expect(checkDiff([docs], pullPatch([docs]), h.diff).pass).toBe(false)
    const shrunk: DiffFile = { filename: 'web/src/components/TaskRow.test.tsx', status: 'modified', patch: "@@ -1 +0,0 @@\n-  it('a', () => {})" }
    expect(checkDiff([shrunk], pullPatch([shrunk]), h.diff).reasons).toContain('test count decreased by 1')
    const styles: DiffFile = { filename: 'web/src/styles.css', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }
    expect(checkDiff([styles], pullPatch([styles]), h.diff)).toEqual({ pass: true, reasons: [] })
  })

  it('the live spec answers and judges ambiguity', () => {
    const spec = readFileSync(join(import.meta.dirname, 'live/code-change.spec.ts'), 'utf8')
    expect(spec).toMatch(/waitForPull(<[^>]*>)?\(/)
    for (const needle of ['judgeAmbiguity(', 'runLocalCi(', 'postAnswer']) {
      expect(spec).toContain(needle)
    }
  })
})

describe.skipIf(process.env.SUPERAGENT_CLAUDE_SEED_INSTALL !== '1')('UI hidden tests with an installed seed', () => {
  let installed = ''
  let installRoot = ''

  const linkInstall: Install = async root => {
    symlinkSync(join(installed, 'node_modules'), join(root, 'node_modules'), 'dir')
    return { code: 0, output: 'linked' }
  }

  const variant = (overlay?: boolean, edit?: (dir: string) => void): string => {
    const dir = tmp()
    copySeed(dir, overlay ? UI : undefined)
    edit?.(dir)
    return dir
  }

  const treeOf = (dir: string) => async (_sha: string, target: string): Promise<void> => {
    cpSync(dir, target, { recursive: true, filter: s => !s.split(sep).includes('node_modules') })
  }

  const linkedHidden = (dir: string, hiddenDir: string): void => {
    cpSync(hiddenDir, join(dir, 'web/src/hidden-acceptance'), { recursive: true })
    symlinkSync(join(installed, 'node_modules'), join(dir, 'node_modules'), 'dir')
  }

  const vitestResults = async (dir: string, tz: string): Promise<Map<string, ('passed' | 'failed')[]>> => {
    const scenario = await uiScenario(UI)
    const web = join(dir, 'web')
    cpSync(HIDDEN_DIR(scenario), join(web, 'src/hidden-acceptance'), { recursive: true })
    symlinkSync(join(installed, 'node_modules'), join(dir, 'node_modules'), 'dir')
    const out = join(tmp(), 'results.json')
    await runCommand(process.execPath, ['../node_modules/vitest/vitest.mjs', 'run', 'src/hidden-acceptance/', '--reporter=json', '--outputFile=' + out], {
      cwd: web,
      env: { PATH: process.env.PATH ?? '', HOME: tmp(), TZ: tz },
      timeoutMs: 300_000,
    })
    const report = JSON.parse(readFileSync(out, 'utf8')) as { testResults: { assertionResults: { title: string; status: string }[] }[] }
    const results = new Map<string, ('passed' | 'failed')[]>()
    for (const file of report.testResults) {
      for (const assertion of file.assertionResults) {
        const list = results.get(assertion.title) ?? []
        list.push(assertion.status === 'passed' ? 'passed' : 'failed')
        results.set(assertion.title, list)
      }
    }
    return results
  }

  beforeAll(async () => {
    installRoot = mkdtempSync(join(tmpdir(), 'live-ui-installed-'))
    installed = join(installRoot, 'seed')
    cpSync(SEED_DIR, installed, { recursive: true, filter: s => !s.split(sep).includes('node_modules') })
    const home = join(installRoot, 'home')
    const install = await npmCi(installed, { PATH: process.env.PATH ?? '', HOME: home, npm_config_cache: join(home, '.npm'), npm_config_update_notifier: 'false' }, 540_000)
    if (install.code !== 0) throw new Error('seed install failed\n' + install.output)
  }, 600_000)

  afterAll(() => {
    if (installRoot) rmSync(installRoot, { recursive: true, force: true })
  })

  it('hidden fails on the seed and passes with the reference', async () => {
    const g = await uiScenario(UI)
    const onSeed = await runHidden('base', g, { fetchTree: async (_, d) => copySeed(d), install: linkInstall })
    expect(onSeed.passed).toBe(false)
    expect(onSeed.runs).toBe(3)
    const onReference = await runHidden('head', g, { fetchTree: async (_, d) => copySeed(d, UI), install: linkInstall })
    expect(onReference.passed).toBe(true)
    expect(onReference.runs).toBe(3)
  }, HIDDEN)

  it('only the target test fails on the seed', async () => {
    const results = await vitestResults(variant(), 'UTC')
    expect(results.get('the overdue row differs from the base')).toEqual(['failed', 'failed', 'failed'])
    expect(results.get('rows that are not overdue match the base')).toEqual(['passed', 'passed', 'passed'])
    expect(results.get('other components match the base')).toEqual(['passed', 'passed', 'passed'])
  }, HIDDEN)

  it('implementation-independent: other markup for the overdue row passes all tests', async () => {
    const variantB = `import type { Task } from '../types.ts'
import { StatusBadge } from './StatusBadge.tsx'

const key = (date: Date): string => {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

const late = (task: Task): boolean => task.status !== 'done' && task.dueDate !== null && task.dueDate < key(new Date())

export function TaskRow({ task }: { task: Task }) {
  const overdue = late(task)
  return (
    <li className="task-row" {...(overdue ? { 'data-overdue': 'true' } : {})}>
      <span className="task-title">{task.title}</span>
      <StatusBadge status={task.status} />
      <span className="task-due">{task.dueDate === null ? 'No due date' : (overdue ? 'Overdue since ' : 'Due ') + task.dueDate}</span>
    </li>
  )
}
`
    const b = variant(true, dir => writeFileSync(join(dir, 'web/src/components/TaskRow.tsx'), variantB))
    const onB = await runHidden('head', await uiScenario(UI), { fetchTree: treeOf(b), install: linkInstall })
    expect(onB.passed).toBe(true)
    expect(onB.runs).toBe(3)
    const onReference = await runHidden('head', await uiScenario(UI), { fetchTree: async (_, d) => copySeed(d, UI), install: linkInstall })
    expect(onReference.passed).toBe(true)
    const results = await vitestResults(variant(true, dir => writeFileSync(join(dir, 'web/src/components/TaskRow.tsx'), variantB)), 'UTC')
    expect([...results.values()].flat().every(status => status === 'passed')).toBe(true)
    expect(results.size).toBe(3)
  }, HIDDEN)

  it('changing the status badge fails the non-target tests', async () => {
    const badge = variant(true, dir => {
      const file = join(dir, 'web/src/components/StatusBadge.tsx')
      writeFileSync(file, readFileSync(file, 'utf8').replace("'badge badge-' + status", "'badge badge-' + status + ' badge-pill'"))
    })
    const onBadge = await vitestResults(badge, 'UTC')
    expect(onBadge.get('other components match the base')).toContain('failed')
    expect(onBadge.get('rows that are not overdue match the base')).toContain('failed')
  }, HIDDEN)

  it('marking every row fails the non-overdue rows test', async () => {
    const everyRow = variant(true, dir => {
      const file = join(dir, 'web/src/components/TaskRow.tsx')
      writeFileSync(file, readFileSync(file, 'utf8').replace("<li className={isOverdue(task) ? 'task-row task-row-overdue' : 'task-row'}>", "<li className={isOverdue(task) ? 'task-row task-row-overdue' : 'task-row'} data-overdue={isOverdue(task) ? 'yes' : 'no'}>"))
    })
    const onEveryRow = await vitestResults(everyRow, 'UTC')
    expect(onEveryRow.get('rows that are not overdue match the base')).toContain('failed')
    expect(onEveryRow.get('other components match the base')).toEqual(['passed', 'passed', 'passed'])
  }, HIDDEN)

  it('the result does not depend on TZ', async () => {
    const seedUtc = await vitestResults(variant(), 'UTC')
    const referenceUtc = await vitestResults(variant(true), 'UTC')
    for (const tz of TZ_CASES.slice(1)) {
      expect(await vitestResults(variant(), tz), 'seed ' + tz).toEqual(seedUtc)
      expect(await vitestResults(variant(true), tz), 'reference ' + tz).toEqual(referenceUtc)
    }
  }, HIDDEN)

  it('base DOM fixture matches the seed', async () => {
    const scenario = await uiScenario(UI)
    const base = JSON.parse(readFileSync(join(HIDDEN_DIR(scenario), 'base-dom.json'), 'utf8')) as { seedVersion: string }
    expect(base.seedVersion).toBe(readFileSync(join(SEED_DIR, '.seed-version'), 'utf8').trim())
    const dir = variant()
    linkedHidden(dir, HIDDEN_DIR(scenario))
    writeFileSync(
      join(dir, 'web/src/hidden-acceptance/zz-base.test.tsx'),
      [
        "import { expect, it, vi } from 'vitest'",
        "import base from './base-dom.json'",
        "import { serialize } from './serialize.tsx'",
        "it('the base dom matches the fixture', async () => {",
        "  vi.useFakeTimers({ toFake: ['Date'] })",
        "  vi.setSystemTime(new Date('2026-11-11T12:00:00Z'))",
        '  const dom = await serialize()',
        '  vi.useRealTimers()',
        '  expect({ rows: dom.rows, components: dom.components }).toEqual({ rows: base.rows, components: base.components })',
        '})',
        '',
      ].join('\n'),
    )
    const res = await runCommand(process.execPath, ['../node_modules/vitest/vitest.mjs', 'run', 'src/hidden-acceptance/zz-base.test.tsx'], {
      cwd: join(dir, 'web'),
      env: { PATH: process.env.PATH ?? '', HOME: tmp(), TZ: 'UTC' },
      timeoutMs: 300_000,
    })
    expect(res.code, res.output).toBe(0)
  }, HIDDEN)

  it('the reference web workspace typechecks', async () => {
    const scenario = await uiScenario(UI)
    const dir = variant(true)
    linkedHidden(dir, HIDDEN_DIR(scenario))
    const res = spawnSync(process.execPath, [join(installed, 'node_modules/typescript/bin/tsc'), '-p', join(dir, 'web/tsconfig.json'), '--noEmit'], { encoding: 'utf8' })
    expect(res.status, res.stdout + res.stderr).toBe(0)
  }, HIDDEN)
})
