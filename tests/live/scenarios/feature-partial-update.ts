import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'feature-partial-update',
  tier: 'core',
  kind: 'feature',
  issue: {
    title: 'Add partial updates for tasks',
    body: '@{{agent}} Please add PATCH /tasks/:id that changes only the given fields (title, status, dueDate) of a task. Validate them like task creation, return 400 for invalid fields, 404 for an unknown id and 403 when the caller does not own the task, and respond with the updated task. Add a service-level update with unit tests and an HTTP test in api/test, make sure npm run typecheck and npm test pass at the repository root, and open a pull request.',
  },
  hidden: {
    dir: 'playground-hidden/feature-partial-update',
    dest: 'api/test/hidden-acceptance',
    workspace: 'api',
    command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
  },
  diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false },
}
