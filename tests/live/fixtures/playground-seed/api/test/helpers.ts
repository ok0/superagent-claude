import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AppConfig } from '../src/config/index.ts'
import { createTaskService } from '../src/services/task-service.ts'
import { createApp } from '../src/http/server.ts'
import { createLogger } from '../src/log/logger.ts'
import { createIdGenerator } from '../src/store/ids.ts'
import { createMemoryStore } from '../src/store/memory-store.ts'

export const AUTH_A = { authorization: 'Bearer tok-a' }
export const AUTH_B = { authorization: 'Bearer tok-b' }

export async function startServer(): Promise<{ base: string; close(): Promise<void> }> {
  const tokens = new Map([['tok-a', 'alice'], ['tok-b', 'bob']])
  const config: AppConfig = { port: 0, pageSize: 20, maxPageSize: 100, tokens, logLevel: 'error' }
  const service = createTaskService({ store: createMemoryStore(), nextId: createIdGenerator() })
  const logger = createLogger({ level: 'error', sink: () => {} })
  const server = createApp({ config, service, logger })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((err) => (err ? reject(err) : resolve()))
      }),
  }
}
