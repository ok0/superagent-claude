import { UnauthorizedError } from '../services/errors.ts'
import { bearerToken } from './tokens.ts'

export function authenticate(header: string | undefined, tokens: ReadonlyMap<string, string>): string {
  const token = bearerToken(header)
  const userId = token === null ? undefined : tokens.get(token)
  if (userId === undefined) throw new UnauthorizedError('invalid or missing token')
  return userId
}
