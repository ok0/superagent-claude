import { now } from '../config/clock.ts'
import { canModify } from '../auth/roles.ts'
import type { TaskStore } from '../store/memory-store.ts'
import { createIdGenerator } from '../store/ids.ts'
import type { Task } from '../store/types.ts'
import { ForbiddenError, NotFoundError } from './errors.ts'
import { validateNewTask } from './validation.ts'

export interface TaskPage {
  items: Task[]
  next: number | null
}

export interface TaskService {
  create(input: unknown, ownerId: string): Task
  get(id: string): Task
  list(o: { start: number; limit: number }): TaskPage
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
    remove(id, userId) {
      const task = store.get(id)
      if (!task) throw new NotFoundError('task not found')
      if (!canModify(task, userId)) throw new ForbiddenError('not allowed to delete this task')
      store.remove(id)
    },
  }
}
