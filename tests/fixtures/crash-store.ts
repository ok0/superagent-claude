/**
 * Child entry for the transaction crash test: commits one reply effect, then SIGKILLs itself inside a transaction
 * that never commits.
 */
import { Effects } from '../../src/app/effects.ts'
import { Store } from '../../src/app/store.ts'
import { HealthBoard } from '../../src/infra/health.ts'

const path = process.argv[2]!
const store = new Store(path)
const effects = new Effects(store, new HealthBoard())
store.atomic(() => effects.enqueue('reply', 'committed', {}))
store.atomic(() => {
  effects.enqueue('reply', 'uncommitted', {})
  process.kill(process.pid, 'SIGKILL')
})
