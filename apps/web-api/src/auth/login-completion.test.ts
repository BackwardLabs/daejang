import { describe, expect, it } from 'vitest'

import { AuthRateLimiter, MemoryRateLimitStore } from './rate-limit.js'
import { LoginCompletionService } from './login-completion.js'
import { MemorySessionStore, SessionService } from './session.js'

const sessionInput = (userId: string) => ({
  user: { id: userId, displayName: '김대장' },
})

const USER_ID = '00000000-0000-4000-8000-000000000001'
const PREVIOUS_USER_ID = '00000000-0000-4000-8000-000000000003'

describe('LoginCompletionService', () => {
  it('rate-limits by provider before replacing the previous session token', async () => {
    const sessions = new SessionService(new MemorySessionStore(), 3_600, 600)
    const service = new LoginCompletionService(
      new AuthRateLimiter(new MemoryRateLimitStore(), 'test-secret'),
      sessions,
    )
    const previous = await sessions.create(sessionInput(PREVIOUS_USER_ID))

    const authenticated = await service.complete({
      provider: 'siwe',
      ip: '203.0.113.10',
      providerIdentity: '0xabc',
      currentSessionToken: previous.token,
      verifyProvider: async () => sessionInput(USER_ID),
    })

    expect(await sessions.resolve(previous.token)).toBeUndefined()
    expect(authenticated.session.user.id).toBe(USER_ID)
    expect(authenticated.rateLimit.allowed).toBe(true)
  })

  it('rejects an exhausted bucket before invoking provider verification', async () => {
    const sessions = new SessionService(new MemorySessionStore(), 3_600, 600)
    const service = new LoginCompletionService(
      new AuthRateLimiter(new MemoryRateLimitStore(), 'test-secret'),
      sessions,
    )
    let verificationCalls = 0
    const input = {
      provider: 'siwe' as const,
      ip: '203.0.113.10',
      providerIdentity: '0xabc',
      currentSessionToken: undefined,
      verifyProvider: async () => {
        verificationCalls += 1
        return sessionInput(USER_ID)
      },
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.complete(input)
    }
    await expect(service.complete(input)).rejects.toMatchObject({
      code: 'RATE_LIMIT_EXCEEDED',
      headers: { 'retry-after': expect.any(String) },
    })
    expect(verificationCalls).toBe(5)
  })
})
