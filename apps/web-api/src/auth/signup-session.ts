import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type {
  AccountAuthStore,
  AccountUser,
  LegalDocumentType,
} from './account-auth-store.js'

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url')

export class SignupSessionService {
  constructor(
    private readonly store: AccountAuthStore,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(userId: string) {
    const token = randomBytes(32).toString('base64url')
    const createdAt = this.now()
    const expiresAt = new Date(createdAt.getTime() + this.ttlSeconds * 1_000)
    await this.store.createSignupSession({
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId,
      createdAt,
      expiresAt,
    })
    return { token, expiresAt }
  }

  async resolve(token: string): Promise<AccountUser | undefined> {
    return this.store.resolveSignupSession(hashToken(token), this.now())
  }

  async revoke(token: string) {
    await this.store.revokeSignupSession(hashToken(token), this.now())
  }

  async complete(
    token: string,
    userId: string,
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>,
  ) {
    return this.store.completeSignup({
      userId,
      signupTokenHash: hashToken(token),
      now: this.now(),
      requiredDocumentTypes,
    })
  }
}
