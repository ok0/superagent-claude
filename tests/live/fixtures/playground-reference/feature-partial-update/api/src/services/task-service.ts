import { now } from '../config/clock.ts'
import { canModify } from '../auth/roles.ts'
import type { TaskStore } from '../store/memory-store.ts'
import { createIdGenerator } from '../store/ids.ts'
import type { Task } from '../store/types.ts'
import { ForbiddenError, NotFoundError, ValidationError } from './errors.ts'
import { isDateKey, parseStatus, validateNewTask } from './validation.ts'

export interface TaskPage {
  items: Task[]
  next: number | null
}

export interface TaskService {
  create(input: unknown, ownerId: string): Task
  get(id: string): Task
  list(o: { start: number; limit: number }): TaskPage
  update(id: string, input: unknown, userId: string): Task
  remove(id: string, userId: string): void
}

export function createTaskService(deps: { store: TaskStore; nextId?: () => string; now?: () => Date }): TaskService {
  const store = deps.store
  const nextId = deps.nextId ?? createIdGenerator()
  const clock = deps.now ?? now
  return {
    create(input, ownerId) {
      const draft = validateNewTask(input)
      const stamp = clock().toISOString()
      return store.insert({
        id: nextId(),
        title: draft.title,
        status: draft.status ?? 'todo',
        dueDate: draft.dueDate ?? null,
        ownerId,
        createdAt: stamp,
        updatedAt: stamp,
      })
    },
    get(id) {
      const task = store.get(id)
      if (!task) throw new NotFoundError('task not found')
      return task
    },
    list(o) {
      const last = store.lastIndex()
      const end = Math.min(o.start + o.limit, last)
      const items = store.all().slice(o.start, end)
      return { items, next: end < last ? end : null }
    },
    update(id, input, userId) {
      const task = store.get(id)
      if (!task) throw new NotFoundError('task not found')
      if (!canModify(task, userId)) throw new ForbiddenError('not allowed to change this task')
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        throw new ValidationError('body must be an object')
      }
      const record = input as Record<string, unknown>
      const keys = Object.keys(record)
      for (const key of keys) {
        if (!['title', 'status', 'dueDate'].includes(key)) throw new ValidationError(`unknown field: ${key}`)
      }
      if (keys.length === 0) throw new ValidationError('nothing to update')
      const patch: Partial<Pick<Task, 'title' | 'status' | 'dueDate'>> = {}
      if (record.title !== undefined) {
        if (typeof record.title !== 'string') throw new ValidationError('title must be a string')
        const title = record.title.trim()
        if (title.length < 1 || title.length > 200) throw new ValidationError('title must be 1-200 characters')
        patch.title = title
      }
      if (record.status !== undefined) patch.status = parseStatus(record.status)
      if (record.dueDate !== undefined) {
        if (record.dueDate !== null && !isDateKey(record.dueDate)) {
          throw new ValidationError('dueDate must be YYYY-MM-DD or null')
        }
        patch.dueDate = record.dueDate as string | null
      }
      return store.replace({ ...task, ...patch, updatedAt: clock().toISOString() })
    },
    remove(id, userId) {
      const task = store.get(id)
      if (!task) throw new NotFoundError('task not found')
      if (!canModify(task, userId)) throw new ForbiddenError('not allowed to delete this task')
      store.remove(id)
    },
  }
}
