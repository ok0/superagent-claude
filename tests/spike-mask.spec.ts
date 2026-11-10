import { describe, expect, it } from 'vitest'
import { checkText } from '../scripts/check-branding.ts'
import { mask, scanForSecrets, secretValues } from '../spikes/sdk/lib/mask.ts'

const K = 'sk-' + 'ant-' + 'test-AAAAAAAAAAAA'
const T = 'sk-' + 'ant-' + 'oat01-test-BBBBBBBB'
const PREFIX = 'sk-' + 'ant-'

describe('mask', () => {
  it('replaces secret values and the credential prefix', () => {
    const result = mask('key=' + K + ' tok=' + T, [K, T])
    expect(result).not.toContain(PREFIX)
    expect(result.split('[REDACTED]').length - 1).toBe(2)
  })

  it('rewrites the product-name phrase to the allowed wording', () => {
    const result = mask('use ' + 'Claude' + ' Code' + ' here', [])
    expect(result).toContain('claude-code')
    expect(checkText('x.md', result)).toEqual([])
  })
})

describe('scanForSecrets', () => {
  it('returns no findings for clean text', () => {
    expect(scanForSecrets('nothing to see\nhere', [K])).toEqual([])
  })

  it('reports a secret value or a raw credential prefix', () => {
    expect(scanForSecrets('line ' + K, [K]).length).toBeGreaterThan(0)
    expect(scanForSecrets('line ' + PREFIX + 'zzz', [K]).length).toBeGreaterThan(0)
  })
})

describe('secretValues', () => {
  it('ignores values shorter than 8 characters', () => {
    expect(secretValues({ ANTHROPIC_API_KEY: 'short' })).toEqual([])
    expect(secretValues({ ANTHROPIC_API_KEY: K })).toEqual([K])
  })
})
