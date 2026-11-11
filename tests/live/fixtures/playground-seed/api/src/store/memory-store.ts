import type { Task } from './types.ts'

export interface TaskStore {
  insert(task: Task): Task
  get(id: string): Task | undefined
  replace(task: Task): Task
  remove(id: string): boolean
  all(): Task[]
  count(): number
  lastIndex(): number
}

const copyTask = (task: Task): Task => ({ ...task })

export function createMemoryStore(): TaskStore {
  const tasks = new Map<string, Task>()
  return {
    insert(task) {
      if (tasks.has(task.id)) throw new Error('duplicate task id ' + task.id)
      tasks.set(task.id, copyTask(task))
      return copyTask(task)
    },
    get(id) {
      const task = tasks.get(id)
      return task === undefined ? undefined : copyTask(task)
    },
    replace(task) {
      if (!tasks.has(task.id)) throw new Error('unknown task id ' + task.id)
      tasks.set(task.id, copyTask(task))
      return copyTask(task)
    },
    remove(id) {
      return tasks.delete(id)
    },
    all() {
      return [...tasks.values()].map(copyTask)
    },
    count() {
      return tasks.size
    },
    /** Index of the last task in insertion order. */
    lastIndex() {
      return tasks.size - 1
    },
  }
}
