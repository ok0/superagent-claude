/** Masking of secret values and token shapes in text shown to people or written to logs. */

export const REDACTED = '[redacted]'

export function redactor(env: Readonly<Record<string, string | undefined>>, mask = '***'): (text: string) => string {
  const values: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length >= 8 && /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL)/i.test(name)) values.push(value)
  }
  return text => {
    let out = text
    for (const value of values) out = out.split(value).join(mask)
    return out
      .replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, mask)
      .replace(/\b[A-Za-z]+_pat_[A-Za-z0-9_]{16,}/g, mask)
      .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, mask)
      .replace(/x-access-token:[^@\s]+@/g, `x-access-token:${mask}@`)
  }
}

export function redact(text: string, env: Readonly<Record<string, string | undefined>>, mask = '***'): string {
  return redactor(env, mask)(text)
}
