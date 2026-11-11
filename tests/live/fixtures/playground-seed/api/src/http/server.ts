import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AppConfig } from '../config/index.ts'
import type { Logger } from '../log/logger.ts'
import type { TaskService } from '../services/task-service.ts'
import { sendError, sendJson } from './respond.ts'
import { matchRoute, type Route } from './router.ts'
import { healthRoutes } from './routes/health.ts'
import { taskRoutes } from './routes/tasks.ts'

export function createApp(deps: { config: AppConfig; service: TaskService; logger: Logger }): Server {
  const routes: Route[] = [...healthRoutes(), ...taskRoutes(deps)]
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const method = req.method ?? 'GET'
    res.on('finish', () => {
      deps.logger.debug('request', { method, path: url.pathname, status: res.statusCode })
    })
    try {
      const match = matchRoute(routes, method, url.pathname)
      if (match === null) {
        sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } })
      } else if ('allowed' in match) {
        res.setHeader('Allow', match.allowed.join(', '))
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'method not allowed' } })
      } else {
        await match.route.handler({ req, res, url, params: match.params })
      }
    } catch (error) {
      sendError(res, error, deps.logger)
    }
  })
}
