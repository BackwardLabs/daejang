import {
  describe,
  expect,
  it,
  vi,
} from 'vitest'

import type { RateLimitStore } from '../auth/rate-limit.js'
import { ReportAttestationWriteRateLimiter } from './write-rate-limit.js'

const now = new Date('2027-01-01T12:00:00.000Z')

const storeReturning = (...usage: number[]) => {
  const increment = vi.fn<RateLimitStore['increment']>(
    async () => usage.shift() ?? 1,
  )
  return {
    increment,
    store: {
      durable: true,
      increment,
    } satisfies RateLimitStore,
  }
}

describe('ReportAttestationWriteRateLimiter', () => {
  it('checks user, IP, then global capacity for an allowed write', async () => {
    const { increment, store } = storeReturning(1, 1, 1)
    const limiter = new ReportAttestationWriteRateLimiter(
      store,
      'test-rate-limit-secret',
      { user: 4, ip: 20, global: 100 },
      () => now,
    )

    await expect(
      limiter.consume({
        userId: 'user-1',
        ip: '127.0.0.1',
        action: 'SUBMIT',
      }),
    ).resolves.toMatchObject({ allowed: true })
    expect(
      increment.mock.calls.map(([input]) => input.scope),
    ).toEqual([
      'report-attestation:write:user',
      'report-attestation:write:ip',
      'report-attestation:write:global',
    ])
  })

  it('does not burn IP or global capacity after the user limit is exhausted', async () => {
    const { increment, store } = storeReturning(5)
    const limiter = new ReportAttestationWriteRateLimiter(
      store,
      'test-rate-limit-secret',
      { user: 4, ip: 20, global: 100 },
      () => now,
    )

    await expect(
      limiter.consume({
        userId: 'user-1',
        ip: '127.0.0.1',
        action: 'REVIEW',
      }),
    ).resolves.toMatchObject({ allowed: false })
    expect(increment).toHaveBeenCalledTimes(1)
  })

  it('does not burn global capacity after the IP limit is exhausted', async () => {
    const { increment, store } = storeReturning(2, 21)
    const limiter = new ReportAttestationWriteRateLimiter(
      store,
      'test-rate-limit-secret',
      { user: 4, ip: 20, global: 100 },
      () => now,
    )

    await expect(
      limiter.consume({
        userId: 'user-1',
        ip: '127.0.0.1',
        action: 'SUBMIT',
      }),
    ).resolves.toMatchObject({ allowed: false })
    expect(increment).toHaveBeenCalledTimes(2)
  })
})
