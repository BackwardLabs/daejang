import { createHash, randomBytes, randomUUID } from 'node:crypto'

export type WorkspaceRole = 'owner' | 'member'

export type WorkspaceMembership = {
  workspaceId: string
  workspaceName: string
  role: WorkspaceRole
}

export type SessionRecord = {
  id: string
  user: {
    id: string
    displayName: string
  }
  memberships: readonly WorkspaceMembership[]
  membershipVersion: number
  sessionEpoch: number
  activeWorkspaceId: string
  createdAt: Date
  lastSeenAt: Date
  absoluteExpiresAt: Date
  idleExpiresAt: Date
}

export type NewSession = Omit<
  SessionRecord,
  | 'id'
  | 'membershipVersion'
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
  readonly #membershipVersions = new Map<string, number>()
  readonly #sessionEpochs = new Map<string, number>()

  async resolveAndTouch({ tokenHash, now, idleTtlMilliseconds }: SessionTransition) {
    const session = this.#sessions.get(tokenHash)
    if (!session) {
      return undefined
    }

    if (
      session.membershipVersion !== this.#currentMembershipVersion(session.user.id) ||
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
      membershipVersion: this.#currentMembershipVersion(session.user.id),
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
      session.membershipVersion !== this.#currentMembershipVersion(session.user.id) ||
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
    if (currentTokenHash && !this.#sessions.delete(currentTokenHash)) {
      return undefined
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

  bumpMembershipVersion(userId: string) {
    const next = this.#currentMembershipVersion(userId) + 1
    this.#membershipVersions.set(userId, next)
    return next
  }

  #currentMembershipVersion(userId: string) {
    return this.#membershipVersions.get(userId) ?? 1
  }

  #currentSessionEpoch(userId: string) {
    return this.#sessionEpochs.get(userId) ?? 1
  }
}

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url')

const assertActiveWorkspaceMembership = (input: NewSession) => {
  if (!input.memberships.some(({ workspaceId }) => workspaceId === input.activeWorkspaceId)) {
    throw new Error('The active workspace must be present in the session memberships')
  }
}

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly absoluteTtlSeconds: number,
    private readonly idleTtlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: NewSession) {
    assertActiveWorkspaceMembership(input)
    const now = this.now()
    const token = randomBytes(32).toString('base64url')
    const session: SessionRecord = {
      ...input,
      id: randomUUID(),
      membershipVersion: 0,
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
    assertActiveWorkspaceMembership(input)
    const now = this.now()
    const token = randomBytes(32).toString('base64url')
    const replacement: SessionRecord = {
      ...input,
      id: randomUUID(),
      membershipVersion: 0,
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
