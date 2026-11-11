import { TASK_STATUSES } from '../store/types.ts'
import type { NewTask, TaskStatus } from '../store/types.ts'
import { ValidationError } from './errors.ts'

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/
const NEW_TASK_KEYS = ['title', 'status', 'dueDate']

export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export function parseStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus
  }
  throw new ValidationError('invalid status')
}

export function validateNewTask(input: unknown): NewTask {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ValidationError('body must be an object')
  }
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!NEW_TASK_KEYS.includes(key)) throw new ValidationError(`unknown field: ${key}`)
  }
  const raw = record.title
  if (typeof raw !== 'string') throw new ValidationError('title must be a string')
  const title = raw.trim()
  if (title.length < 1 || title.length > 200) throw new ValidationError('title must be 1-200 characters')
  const draft: NewTask = { title }
  if (record.status !== undefined) draft.status = parseStatus(record.status)
  if (record.dueDate !== undefined) {
    if (record.dueDate !== null && !isDateKey(record.dueDate)) {
      throw new ValidationError('dueDate must be YYYY-MM-DD or null')
    }
    draft.dueDate = record.dueDate as string | null
  }
  return draft
}
