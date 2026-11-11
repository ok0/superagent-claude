import type { LiveScenario } from '../scenarios.ts'

export const scenario: LiveScenario = {
  id: 'flaky-date',
  tier: 'extended',
  issue: {
    title: 'A test fails now and then on some machines',
    body: '@{{agent}} One of the api tests passes on most runs but fails on some machines and in some environments, even though nothing in the code changed. Please find out why, make the test suite reliable without dropping coverage, keep npm run typecheck and npm test passing at the repository root, and open a pull request.',
  },
  hidden: {
    dir: 'playground-hidden/flaky-date',
    dest: 'api/test/hidden-acceptance',
    workspace: 'api',
    command: ['node', '--test'],
    envMatrix: [
      { FAKE_NOW: '2001-02-03T12:00:00Z', TZ: 'UTC' },
      { FAKE_NOW: '2012-07-15T23:30:00Z', TZ: 'Pacific/Kiritimati' },
      { FAKE_NOW: '2033-01-01T00:30:00Z', TZ: 'America/Los_Angeles' },
    ],
    repeat: 3,
  },
  diff: { requireSourceAndTest: false, allowedRoots: ['api/'], allowLockfile: false },
}
