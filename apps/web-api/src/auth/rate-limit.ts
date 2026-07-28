import { createHmac } from 'node:crypto'

import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Pool } from 'pg'

import { rateLimitExceeded } from '../errors.js'

export type LoginProvider = 'siwe' | 'oauth' | 'email' | 'session'
export type LoginPhase = 'begin' | 'complete'

type RateLimitPolicy = {
  limit: number
  windowSeconds: number
}

const providerPolicies: Record<LoginProvider, Record<LoginPhase, RateLimitPolicy>> = {
  siwe: {
    begin: { limit: 10, windowSeconds: 60 },
    complete: { limit: 5, windowSeconds: 300 },
  },
  oauth: {
    begin: { limit: 20, windowSeconds: 60 },
    complete: { limit: 10, windowSeconds: 300 },
  },
  email: {
    begin: { limit: 5, windowSeconds: 300 },
    complete: { limit: 10, windowSeconds: 300 },
  },
  session: {
    begin: { limit: 10, windowSeconds: 3_600 },
    complete: { limit: 10, windowSeconds: 3_600 },
  },
}

type IncrementInput = {
  scope: string
  keyHash: string
  windowStartedAt: Date
  windowExpiresAt: Date
}

export interface RateLimitStore {
  readonly durable: boolean
  increment(input: IncrementInput): Promise<number>
}

export class MemoryRateLimitStore implements RateLimitStore {
  readonly durable: boolean = false
  readonly #buckets = new Map<string, { attempts: number; expiresAt: number }>()

  async increment(input: IncrementInput) {
    const key = `${input.scope}:${input.keyHash}:${input.windowStartedAt.toISOString()}`
    const current = this.#buckets.get(key)
    const attempts = (current?.attempts ?? 0) + 1
    this.#buckets.set(key, { attempts, expiresAt: input.windowExpiresAt.getTime() })
    return attempts
  }
}

export class PostgresRateLimitStore implements RateLimitStore {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async increment(input: IncrementInput) {
    const result = await this.pool.query<{ attempts: number }>(
      `
        INSERT INTO web_private.auth_rate_limit_buckets (
          scope,
          key_hash,
          window_started_at,
          window_expires_at,
          attempts
        ) VALUES ($1, $2, $3, $4, 1)
        ON CONFLICT (scope, key_hash, window_started_at) DO UPDATE
        SET attempts = web_private.auth_rate_limit_buckets.attempts + 1
        RETURNING attempts
      `,
      [input.scope, input.keyHash, input.windowStartedAt, input.windowExpiresAt],
    )

    const attempts = result.rows[0]?.attempts
    if (!Number.isSafeInteger(attempts) || attempts === undefined) {
      throw new Error('PostgreSQL did not return a valid rate-limit counter')
    }
    return attempts
  }
}

export type RateLimitDecision = {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

export class AuthRateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly hmacSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(input: {
    provider: LoginProvider
    phase: LoginPhase
    ip: string
    identity?: string | undefined
  }): Promise<RateLimitDecision> {
    const policy = providerPolicies[input.provider][input.phase]
    const now = this.now()
    const windowMilliseconds = policy.windowSeconds * 1_000
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds,
    )
    const windowExpiresAt = new Date(windowStartedAt.getTime() + windowMilliseconds)
    const identity = input.identity?.trim().toLocaleLowerCase('en-US')
    const dimensions = [
      { name: 'ip', value: input.ip },
      ...(identity ? [{ name: 'identity', value: identity }] : []),
    ]
    const attempts = await Promise.all(
      dimensions.map(({ name, value }) =>
        this.store.increment({
          scope: `login:${input.provider}:${input.phase}:${name}`,
          keyHash: createHmac('sha256', this.hmacSecret)
            .update(`${name}\0${value}`)
            .digest('base64url'),
          windowStartedAt,
          windowExpiresAt,
        }),
      ),
    )
    const highestAttempt = Math.max(...attempts)

    return {
      allowed: attempts.every((attempt) => attempt <= policy.limit),
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - highestAttempt),
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((windowExpiresAt.getTime() - now.getTime()) / 1_000),
      ),
    }
  }
}

const writeRateLimitHeaders = (reply: FastifyReply, decision: RateLimitDecision) => {
  reply.header('x-ratelimit-limit', decision.limit)
  reply.header('x-ratelimit-remaining', decision.remaining)
  if (!decision.allowed) {
    reply.header('retry-after', decision.retryAfterSeconds)
  }
}

export const createLoginRateLimitHook = (
  limiter: AuthRateLimiter,
  provider: LoginProvider,
  phase: LoginPhase,
  identityFromRequest: (request: FastifyRequest) => string | undefined = () => undefined,
): preHandlerHookHandler =>
  async (request, reply) => {
    const decision = await limiter.consume({
      provider,
      phase,
      ip: request.ip,
      identity: identityFromRequest(request),
    })
    writeRateLimitHeaders(reply, decision)
    if (!decision.allowed) {
      throw rateLimitExceeded(decision.retryAfterSeconds)
    }
  }
