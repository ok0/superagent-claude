import type { LogLevel } from '../config/index.ts'

export function formatLine(level: LogLevel, message: string, fields: Readonly<Record<string, unknown>>, at: Date): string {
  return JSON.stringify({ time: at.toISOString(), level, msg: message, ...fields })
}
