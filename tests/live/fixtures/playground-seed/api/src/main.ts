import { createApp } from './http/server.ts'
import { loadConfig } from './config/index.ts'
import { createLogger } from './log/logger.ts'
import { createIdGenerator } from './store/ids.ts'
import { createMemoryStore } from './store/memory-store.ts'
import { createTaskService } from './services/task-service.ts'

const config = loadConfig()
const logger = createLogger({ level: config.logLevel })
const service = createTaskService({ store: createMemoryStore(), nextId: createIdGenerator() })
const server = createApp({ config, service, logger })

server.listen(config.port, () => {
  logger.info('listening', { port: config.port })
})
