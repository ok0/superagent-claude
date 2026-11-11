import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'bug-paging',
  tier: 'core',
  issue: {
    title: 'Paging through tasks drops the last one',
    body: '@ok0-worker With five tasks, GET /tasks?limit=2 returns two tasks, then two more with nextCursor null, so the fifth task is never listed. A single page drops its last task too. The paging goes through api/src/http/cursor.ts, api/src/http/routes/tasks.ts, api/src/services/task-service.ts and api/src/store/memory-store.ts. Please fix it, add a test under api/test that pages through every task, make sure npm run typecheck and npm test pass at the repository root, and open a pull request.',
  },
  hidden: {
    dir: 'playground-hidden/bug-paging',
    dest: 'api/test/hidden-acceptance',
    workspace: 'api',
    command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
  },
  diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false, newTestFailsOnBase: true },
}
