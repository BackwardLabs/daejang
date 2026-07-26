import { describe, expect, it } from 'vitest'

import { AuthRateLimiter, MemoryRateLimitStore } from './rate-limit.js'

describe('AuthRateLimiter', () => {
  it('enforces the stricter SIWE completion policy by IP and identity', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const limiter = new AuthRateLimiter(
      new MemoryRateLimitStore(),
      'test-secret',
      () => now,
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const decision = await limiter.consume({
        provider: 'siwe',
        phase: 'complete',
        ip: '203.0.113.10',
        identity: '0xABC',
      })
      expect(decision.allowed).toBe(true)
    }

    const rejected = await limiter.consume({
      provider: 'siwe',
      phase: 'complete',
      ip: '203.0.113.10',
      identity: '0xabc',
    })
    expect(rejected).toMatchObject({ allowed: false, limit: 5, remaining: 0 })
  })

  it('uses independent buckets for providers', async () => {
    const limiter = new AuthRateLimiter(new MemoryRateLimitStore(), 'test-secret')
    const input = { phase: 'complete' as const, ip: '203.0.113.10', identity: 'kim' }

    expect((await limiter.consume({ ...input, provider: 'siwe' })).allowed).toBe(true)
    expect((await limiter.consume({ ...input, provider: 'oidc' })).allowed).toBe(true)
  })

  it('blocks the same identity across rotating IP addresses', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const limiter = new AuthRateLimiter(
      new MemoryRateLimitStore(),
      'test-secret',
      () => now,
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await limiter.consume({
            provider: 'siwe',
            phase: 'complete',
            ip: `203.0.113.${attempt + 1}`,
            identity: '0xabc',
          })
        ).allowed,
      ).toBe(true)
    }

    expect(
      (
        await limiter.consume({
          provider: 'siwe',
          phase: 'complete',
          ip: '203.0.113.200',
          identity: '0xabc',
        })
      ).allowed,
    ).toBe(false)
  })

  it('blocks one IP that rotates identities', async () => {
    const now = new Date('2027-07-20T00:00:00.000Z')
    const limiter = new AuthRateLimiter(
      new MemoryRateLimitStore(),
      'test-secret',
      () => now,
    )

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await limiter.consume({
            provider: 'siwe',
            phase: 'complete',
            ip: '203.0.113.10',
            identity: `0x${attempt}`,
          })
        ).allowed,
      ).toBe(true)
    }

    expect(
      (
        await limiter.consume({
          provider: 'siwe',
          phase: 'complete',
          ip: '203.0.113.10',
          identity: '0xother',
        })
      ).allowed,
    ).toBe(false)
  })
})
