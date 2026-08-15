import { describe, expect, it } from 'vitest'

import type { AppConfig } from './config.js'
import { isAllowedRequestOrigin } from './security.js'

const config = {
  runtimeMode: 'development',
  publicOrigin: 'http://localhost:15173',
} as AppConfig

describe('request origin policy', () => {
  it('allows a different port on the same protocol and hostname in development', () => {
    expect(isAllowedRequestOrigin('http://localhost:60101', config)).toBe(true)
  })

  it.each([
    ['a different hostname', 'http://127.0.0.1:60101'],
    ['a different protocol', 'https://localhost:60101'],
    ['an external hostname', 'http://attacker.example:15173'],
    ['a malformed origin', 'not-an-origin'],
    ['an origin containing a path', 'http://localhost:60101/login'],
    ['a missing origin', undefined],
  ])('rejects %s in development', (_label, origin) => {
    expect(isAllowedRequestOrigin(origin, config)).toBe(false)
  })

  it.each(['test', 'production'] as const)(
    'requires the exact origin, including port, in %s',
    (runtimeMode) => {
      expect(
        isAllowedRequestOrigin('http://localhost:60101', { ...config, runtimeMode }),
      ).toBe(false)
      expect(
        isAllowedRequestOrigin(config.publicOrigin, { ...config, runtimeMode }),
      ).toBe(true)
    },
  )
})
