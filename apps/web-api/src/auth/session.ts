import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type SessionRecord = {
  id: string
  user: {
    id: string
    displayName: string
  }
  verifiedSubjectName?: {
    normalizedValue: string
  }
  sessionEpoch: number
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  idleExpiresAt: Date
}

export type NewSession = Omit<
  SessionRecord,
  | 'id'
  | 'sessionEpoch'
  | 'createdAt'
  | 'lastSeenAt'
  | 'absoluteExpiresAt'
  | 'idleExpiresAt'
>

type SessionTransition = {
  tokenHash: string
  now: Date
  idleTtlMilliseconds: number
}

type RotateSessionTransition = SessionTransition & {
  replacementTokenHash: string
  replacementSessionId: string
}

type ReplaceSessionTransition = {
  currentTokenHash: string | undefined
  replacementTokenHash: string
  replacement: SessionRecord
}

export interface SessionStore {
  readonly durable: boolean
  resolveAndTouch(transition: SessionTransition): Promise<SessionRecord | undefined>
  set(tokenHash: string, session: SessionRecord): Promise<SessionRecord>
  rotate(transition: RotateSessionTransition): Promise<SessionRecord | undefined>
  replaceAfterAuthentication(
    transition: ReplaceSessionTransition,
  ): Promise<SessionRecord | undefined>
  delete(tokenHash: string): Promise<void>
  deleteByUserId(userId: string): Promise<number>
}

export class MemorySessionStore implements SessionStore {
  readonly durable: boolean = false
  readonly #sessions = new Map<string, SessionRecord>()
  readonly #sessionEpochs = new Map<string, number>()

  async resolveAndTouch({ tokenHash, now, idleTtlMilliseconds }: SessionTransition) {
    const session = this.#sessions.get(tokenHash)
    if (!session) {
      return undefined
    }

    if (
      session.sessionEpoch !== this.#currentSessionEpoch(session.user.id) ||
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      session.idleExpiresAt.getTime() <= now.getTime()
    ) {
      this.#sessions.delete(tokenHash)
      return undefined
    }

    const touched: SessionRecord = {
      ...session,
      lastSeenAt: now,
      idleExpiresAt: new Date(
        Math.min(
          session.absoluteExpiresAt.getTime(),
          now.getTime() + idleTtlMilliseconds,
        ),
      ),
    }
    this.#sessions.set(tokenHash, touched)
    return touched
  }

  async set(tokenHash: string, session: SessionRecord) {
    const stored = {
      ...session,
      sessionEpoch: this.#currentSessionEpoch(session.user.id),
    }
    this.#sessions.set(tokenHash, stored)
    return stored
  }

  async rotate({
    tokenHash,
    replacementTokenHash,
    replacementSessionId,
    now,
    idleTtlMilliseconds,
  }: RotateSessionTransition) {
    if (this.#sessions.has(replacementTokenHash)) {
      return undefined
    }

    const session = this.#sessions.get(tokenHash)
    if (
      !session ||
      session.sessionEpoch !== this.#currentSessionEpoch(session.user.id) ||
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      session.idleExpiresAt.getTime() <= now.getTime()
    ) {
      if (session) {
        this.#sessions.delete(tokenHash)
      }
      return undefined
    }

    const replacement: SessionRecord = {
      ...session,
      id: replacementSessionId,
      lastSeenAt: now,
      idleExpiresAt: new Date(
        Math.min(
          session.absoluteExpiresAt.getTime(),
          now.getTime() + idleTtlMilliseconds,
        ),
      ),
    }
    this.#sessions.delete(tokenHash)
    this.#sessions.set(replacementTokenHash, replacement)
    return replacement
  }

  async replaceAfterAuthentication({
    currentTokenHash,
    replacementTokenHash,
    replacement,
  }: ReplaceSessionTransition) {
    if (this.#sessions.has(replacementTokenHash)) {
      return undefined
    }
    if (currentTokenHash) {
      this.#sessions.delete(currentTokenHash)
    }

    return this.set(replacementTokenHash, replacement)
  }

  async delete(tokenHash: string) {
    this.#sessions.delete(tokenHash)
  }

  async deleteByUserId(userId: string) {
    this.#sessionEpochs.set(userId, this.#currentSessionEpoch(userId) + 1)
    let deleted = 0
    for (const [tokenHash, session] of this.#sessions) {
      if (session.user.id === userId) {
        this.#sessions.delete(tokenHash)
        deleted += 1
      }
    }
    return deleted
  }

  #currentSessionEpoch(userId: string) {
    return this.#sessionEpochs.get(userId) ?? 1
  }
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url')

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly absoluteTtlSeconds: number,
    private readonly idleTtlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: NewSession) {
    const now = this.now()
    const token = randomBytes(32).toString('base64url')
    const session: SessionRecord = {
      ...input,
      id: randomUUID(),
      sessionEpoch: 0,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + this.absoluteTtlSeconds * 1_000),
      idleExpiresAt: new Date(now.getTime() + this.idleTtlSeconds * 1_000),
    }

    const storedSession = await this.store.set(hashToken(token), session)
    return { token, session: storedSession }
  }

  async resolve(token: string) {
    return this.store.resolveAndTouch({
      tokenHash: hashToken(token),
      now: this.now(),
      idleTtlMilliseconds: this.idleTtlSeconds * 1_000,
    })
  }

  async rotate(token: string) {
    const replacementToken = randomBytes(32).toString('base64url')
    const session = await this.store.rotate({
      tokenHash: hashToken(token),
      replacementTokenHash: hashToken(replacementToken),
      replacementSessionId: randomUUID(),
      now: this.now(),
      idleTtlMilliseconds: this.idleTtlSeconds * 1_000,
    })

    return session ? { token: replacementToken, session } : undefined
  }

  async revoke(token: string) {
    await this.store.delete(hashToken(token))
  }

  async revokeUser(userId: string) {
    return this.store.deleteByUserId(userId)
  }

  async replaceAfterAuthentication(currentToken: string | undefined, input: NewSession) {
    const now = this.now()
    const token = randomBytes(32).toString('base64url')
    const replacement: SessionRecord = {
      ...input,
      id: randomUUID(),
      sessionEpoch: 0,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt: new Date(now.getTime() + this.absoluteTtlSeconds * 1_000),
      idleExpiresAt: new Date(now.getTime() + this.idleTtlSeconds * 1_000),
    }
    const session = await this.store.replaceAfterAuthentication({
      currentTokenHash: currentToken ? hashToken(currentToken) : undefined,
      replacementTokenHash: hashToken(token),
      replacement,
    })

    return session ? { token, session } : undefined
  }
}
