import { now } from '../config/clock.ts'
import type { Task } from '../store/types.ts'

export function dayKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isDueToday(task: Pick<Task, 'dueDate'>, at: Date = now()): boolean {
  return task.dueDate === dayKey(at)
}

export function isOverdue(task: Pick<Task, 'dueDate' | 'status'>, at: Date = now()): boolean {
  return task.status !== 'done' && task.dueDate !== null && task.dueDate < dayKey(at)
}
