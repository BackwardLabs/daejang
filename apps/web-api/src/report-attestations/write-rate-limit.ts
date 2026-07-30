import { createHmac } from 'node:crypto'

import type { RateLimitStore } from '../auth/rate-limit.js'

type WriteAction = 'SUBMIT' | 'REVIEW'

export type ReportAttestationWriteLimitDecision = Readonly<{
  allowed: boolean
  retryAfterSeconds: number
}>

export class ReportAttestationWriteRateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly hmacSecret: string,
    private readonly limits: Readonly<{
      user: number
      ip: number
      global: number
    }>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(input: {
    userId: string
    ip: string
    action: WriteAction
  }): Promise<ReportAttestationWriteLimitDecision> {
    const now = this.now()
    const windowMilliseconds = 24 * 60 * 60 * 1_000
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowMilliseconds) *
        windowMilliseconds,
    )
    const windowExpiresAt = new Date(
      windowStartedAt.getTime() + windowMilliseconds,
    )
    const dimensions = [
      {
        name: 'user',
        value: input.userId,
        limit: this.limits.user,
      },
      {
        name: 'ip',
        value: input.ip,
        limit: this.limits.ip,
      },
      {
        name: 'global',
        value: 'giwa-sepolia-synthetic-publication-v1',
        limit: this.limits.global,
      },
    ] as const
    for (const { name, value, limit } of dimensions) {
      const usage = await this.store.increment({
        scope: `report-attestation:write:${name}`,
        keyHash: createHmac('sha256', this.hmacSecret)
          .update(`${name}\0${value}`)
          .digest('base64url'),
        windowStartedAt,
        windowExpiresAt,
        cost: 1,
        ceiling: limit + 1,
      })
      if (usage > limit) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (windowExpiresAt.getTime() - now.getTime()) /
                1_000,
            ),
          ),
        }
      }
    }

    return {
      allowed: true,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil(
          (windowExpiresAt.getTime() - now.getTime()) / 1_000,
        ),
      ),
    }
  }
}
