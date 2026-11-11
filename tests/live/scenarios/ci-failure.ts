import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'ci-failure',
  tier: 'extended',
  issue: {
    title: 'Add a test for listing every task page by page',
    body: 'This adds one test that lists tasks page by page.',
  },
  prepare: {
    path: 'api/test/list-pages.test.ts',
    fixture: 'playground-prepared/ci-failure/list-pages.test.ts',
    commitMessage: 'test: list every task page by page',
    comment: '@{{agent}} The checks on this pull request fail. Please find the cause and fix it so that the checks pass, and keep the new test as it is.',
  },
  hidden: {
    dir: 'playground-hidden/bug-paging',
    dest: 'api/test/hidden-acceptance',
    workspace: 'api',
    command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
  },
  diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false },
}
