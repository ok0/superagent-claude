import type { Task } from '../store/types.ts'

export function canModify(task: Pick<Task, 'ownerId'>, userId: string): boolean {
  return task.ownerId === userId
}
