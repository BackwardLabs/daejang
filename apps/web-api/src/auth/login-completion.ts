import { rateLimitExceeded, sessionRotationConflict } from '../errors.js'
import type { AuthRateLimiter, LoginProvider } from './rate-limit.js'
import type { NewSession, SessionService } from './session.js'

export class LoginCompletionService {
  constructor(
    private readonly rateLimiter: AuthRateLimiter,
    private readonly sessions: SessionService,
  ) {}

  async complete(input: {
    provider: Exclude<LoginProvider, 'session'>
    ip: string
    providerIdentity: string
    currentSessionToken: string | undefined
    verifyProvider: () => Promise<NewSession>
  }) {
    const decision = await this.rateLimiter.consume({
      provider: input.provider,
      phase: 'complete',
      ip: input.ip,
      identity: input.providerIdentity,
    })
    if (!decision.allowed) {
      throw rateLimitExceeded(decision.retryAfterSeconds)
    }

    const session = await input.verifyProvider()
    const issued = await this.sessions.replaceAfterAuthentication(
      input.currentSessionToken,
      session,
    )
    if (!issued) {
      throw sessionRotationConflict()
    }
    return { ...issued, rateLimit: decision }
  }
}
