import type { LogLevel } from '../config/index.ts'
import { formatLine } from './format.ts'
import { LineBuffer } from './line-buffer.ts'

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
}

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(o: { level: LogLevel; sink?: (line: string) => void; now?: () => Date }): Logger {
  const now = o.now ?? (() => new Date())
  const sink = o.sink
  const buffer = sink === undefined ? new LineBuffer((chunk) => { process.stdout.write(chunk) }) : undefined
  if (buffer !== undefined) process.on('exit', () => buffer.flush())

  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (RANK[level] < RANK[o.level]) return
    const line = formatLine(level, msg, fields ?? {}, now())
    if (sink !== undefined) {
      sink(line)
      return
    }
    buffer?.write(line)
    if (level === 'error') buffer?.flush()
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
  }
}
