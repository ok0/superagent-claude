/**
 * Environment for subprocesses: only the inherited whitelist (PATH, HOME, LANG) plus explicitly named variables.
 * The daemon environment is never passed whole.
 */
export const INHERITED_ENV = ['PATH', 'HOME', 'LANG'] as const

export function subprocessEnv(
  base: Readonly<Record<string, string | undefined>>,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of INHERITED_ENV) {
    const value = base[key]
    if (typeof value === 'string') result[key] = value
  }
  return Object.assign(result, explicit)
}
