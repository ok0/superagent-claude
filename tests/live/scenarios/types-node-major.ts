import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'types-node-major',
  tier: 'extended',
  issue: {
    title: 'Upgrade @types/node to 26 in the api workspace',
    body: '@{{agent}} Please upgrade @types/node in the api workspace to the latest 26.x release. Keep the lockfile in sync, keep npm run typecheck and npm test passing at the repository root, and open a pull request.',
  },
  hidden: {
    dir: 'playground-hidden/types-node-major',
    dest: 'api/test/hidden-acceptance',
    workspace: 'api',
    command: ['node', '--test', 'test/hidden-acceptance/*.test.ts'],
  },
  diff: { requireSourceAndTest: false, allowedRoots: ['api/'], allowLockfile: true },
}
