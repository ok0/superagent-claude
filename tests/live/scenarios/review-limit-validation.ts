import type { LiveScenario } from '../scenarios.ts'
import { scenario as bug } from './bug-paging.ts'

export const scenario: LiveScenario = {
  id: 'review-limit-validation',
  tier: 'core',
  issue: bug.issue,
  review: {
    body: 'Please also answer GET /tasks with 400 when limit is 0, negative or not a whole number, and add a test for that case.',
  },
  hidden: bug.hidden,
  diff: { requireSourceAndTest: true, allowedRoots: ['api/'], allowLockfile: false },
}
