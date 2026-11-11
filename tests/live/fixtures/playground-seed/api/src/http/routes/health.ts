import { sendJson } from '../respond.ts'
import type { Route } from '../router.ts'

export function healthRoutes(): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/health',
      handler: ({ res }) => {
        sendJson(res, 200, { status: 'ok' })
      },
    },
  ]
}
