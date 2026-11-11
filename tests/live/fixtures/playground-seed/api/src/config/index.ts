import { readInt, readTokens } from './env.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AppConfig {
  port: number
  pageSize: number
  maxPageSize: number
  tokens: Map<string, string>
  logLevel: LogLevel
}

function isLogLevel(value: string): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AppConfig {
  const level = env.LOG_LEVEL ?? 'info'
  if (!isLogLevel(level)) throw new Error('invalid LOG_LEVEL')
  return {
    port: readInt(env, 'PORT', 3000, 0),
    pageSize: readInt(env, 'PAGE_SIZE', 20),
    maxPageSize: readInt(env, 'MAX_PAGE_SIZE', 100),
    tokens: readTokens(env.API_TOKENS),
    logLevel: level,
  }
}
