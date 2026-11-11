import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'ui-overdue-rows',
  tier: 'core',
  kind: 'ui',
  issue: {
    title: 'Overdue tasks are hard to spot in the task list',
    body: '@{{agent}} In the web app, tasks whose due date has already passed look exactly like every other task in the list, so people keep missing them. Please make them easy to notice in the list, keep npm run typecheck and npm test passing at the repository root, and open a pull request.',
  },
  answer: '@{{agent}} Please mark the row of each overdue task in the list itself (an open task whose due date is before today) and leave the other rows and the rest of the page as they are. Any visual treatment is fine.',
  hidden: {
    dir: 'playground-hidden/ui-overdue-rows',
    dest: 'web/src/hidden-acceptance',
    workspace: 'web',
    command: ['node', '../node_modules/vitest/vitest.mjs', 'run', 'src/hidden-acceptance/'],
    envMatrix: [{ TZ: 'UTC' }, { TZ: 'Pacific/Kiritimati' }, { TZ: 'Pacific/Pago_Pago' }],
  },
  diff: { requireSourceAndTest: true, allowedRoots: ['web/'], allowLockfile: false },
}
