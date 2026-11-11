import { ValidationError } from '../services/errors.ts'

export function encodeCursor(position: number): string {
  return Buffer.from(JSON.stringify({ p: position })).toString('base64url')
}

export function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === '') return 0
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    throw new ValidationError('invalid cursor')
  }
  const p = (parsed as { p?: unknown } | null)?.p
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) throw new ValidationError('invalid cursor')
  return p
}
