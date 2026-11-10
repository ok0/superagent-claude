import { FORBIDDEN_PATTERN } from '../../../scripts/check-branding.ts'

const SECRET_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']
const CREDENTIAL_PREFIX = 'sk-' + 'ant-'
const CREDENTIAL_PATTERN = new RegExp(CREDENTIAL_PREFIX + '[A-Za-z0-9_\\-]*', 'g')
const PRODUCT_PATTERN = new RegExp(FORBIDDEN_PATTERN.source, 'gi')

export function secretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = []
  for (const name of SECRET_VARS) {
    const value = env[name]
    if (value !== undefined && value.length >= 8) values.push(value)
  }
  return values
}

export function mask(text: string, secrets: readonly string[]): string {
  let out = text
  for (const secret of secrets) {
    if (secret.length === 0) continue
    out = out.split(secret).join('[REDACTED]')
  }
  out = out.replace(CREDENTIAL_PATTERN, '[REDACTED]')
  out = out.replace(PRODUCT_PATTERN, 'claude-code')
  return out
}

export function scanForSecrets(text: string, secrets: readonly string[]): string[] {
  const findings: string[] = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes(CREDENTIAL_PREFIX)) {
      findings.push(`credential prefix found at line ${index + 1}`)
    }
    for (const secret of secrets) {
      if (secret.length > 0 && line.includes(secret)) {
        findings.push(`secret value found at line ${index + 1}`)
        break
      }
    }
  })
  return findings
}
