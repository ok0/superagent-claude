/** Ambient types for the subset of proper-lockfile 4.1.2 the Store uses (no @types package, M6 AC9). */
declare module 'proper-lockfile' {
  interface LockOptions { stale?: number; update?: number; realpath?: boolean; lockfilePath?: string; onCompromised?: (error: Error) => void }
  export function lockSync(file: string, options?: LockOptions): () => void
  export function checkSync(file: string, options?: LockOptions): boolean
}
