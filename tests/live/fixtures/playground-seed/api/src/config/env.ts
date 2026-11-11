export function readInt(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number, min = 1): number {
  const raw = env[name]
  if (raw === undefined) return fallback
  if (!/^-?\d+$/.test(raw)) throw new Error('invalid ' + name)
  const value = Number(raw)
  if (value < min) throw new Error('invalid ' + name)
  return value
}

export function readTokens(spec: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>()
  if (spec === undefined || spec.trim() === '') return tokens
  for (const entry of spec.split(',')) {
    const separator = entry.indexOf(':')
    if (separator <= 0) throw new Error('invalid API_TOKENS entry')
    const user = entry.slice(0, separator).trim()
    const token = entry.slice(separator + 1).trim()
    if (user === '' || token === '') throw new Error('invalid API_TOKENS entry')
    tokens.set(token, user)
  }
  return tokens
}
