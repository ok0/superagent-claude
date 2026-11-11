import { authenticate } from '../../auth/middleware.ts'
import type { AppConfig } from '../../config/index.ts'
import type { TaskService } from '../../services/task-service.ts'
import { readJson } from '../body.ts'
import { decodeCursor, encodeCursor } from '../cursor.ts'
import { sendJson } from '../respond.ts'
import type { Route } from '../router.ts'

export function taskRoutes(deps: { service: TaskService; config: AppConfig }): Route[] {
  const { service, config } = deps
  return [
    {
      method: 'GET',
      pattern: '/tasks',
      handler: ({ req, res, url }) => {
        authenticate(req.headers.authorization, config.tokens)
        const limit = Math.min(Number(url.searchParams.get('limit') ?? config.pageSize), config.maxPageSize)
        const start = decodeCursor(url.searchParams.get('cursor'))
        const page = service.list({ start, limit })
        sendJson(res, 200, {
          items: page.items,
          nextCursor: page.next === null ? null : encodeCursor(page.next),
        })
      },
    },
    {
      method: 'POST',
      pattern: '/tasks',
      handler: async ({ req, res }) => {
        const userId = authenticate(req.headers.authorization, config.tokens)
        const body = await readJson(req)
        sendJson(res, 201, service.create(body, userId))
      },
    },
    {
      method: 'GET',
      pattern: '/tasks/:id',
      handler: ({ req, res, params }) => {
        authenticate(req.headers.authorization, config.tokens)
        sendJson(res, 200, service.get(params.id!))
      },
    },
    {
      method: "DELETE",
      pattern: '/tasks/:id',
      handler: ({ req, res, params }) => {
        const userId = authenticate(req.headers.authorization, config.tokens)
        service.remove(params.id!, userId)
        res.writeHead(204)
        res.end()
      },
    },
    {
      method: 'PATCH',
      pattern: '/tasks/:id',
      handler: async ({ req, res, params }) => {
        const userId = authenticate(req.headers.authorization, config.tokens)
        const body = await readJson(req)
        sendJson(res, 200, service.update(params.id!, body, userId))
      },
    },
  ]
}
