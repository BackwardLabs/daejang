import { randomUUID } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import type { OAuthProviderName } from '../config.js'
import type { UserStatus } from './postgres-user-store.js'

export type OAuthIntent = 'signup' | 'login' | 'link'
export type EmailChallengePurpose = 'signup' | 'verify_email' | 'password_reset'
export type LegalDocumentType =
  | 'terms'
  | 'privacy'
  | 'privacy_collection'
  | 'identity_verification'
  | 'marketing'

export type AccountUser = {
  id: string
  displayName: string
  status: UserStatus
}

export type OAuthTransactionRecord = {
  id: string
  provider: OAuthProviderName
  intent: OAuthIntent
  stateHash: string
  nonceHash: string | undefined
  pkceVerifierCiphertext: Buffer | undefined
  authenticatedUserId: string | undefined
  returnPath: string
  createdAt: Date
  expiresAt: Date
  consumedAt: Date | undefined
}

export type EmailChallengeRecord = {
  id: string
  userEmailId: string
  email: string
  purpose: EmailChallengePurpose
  codeDigest: string
  createdAt: Date
  expiresAt: Date
  resendAfter: Date
  attempts: number
  maxAttempts: number
  consumedAt: Date | undefined
}

export type CurrentLegalDocument = {
  id: string
  documentType: LegalDocumentType
  locale: string
  version: string
  contentHash: string
  content: string
  effectiveAt: Date
}

export interface AccountAuthStore {
  readonly durable: boolean
  createOAuthTransaction(record: OAuthTransactionRecord): Promise<void>
  consumeOAuthTransaction(
    stateHash: string,
    now: Date,
  ): Promise<OAuthTransactionRecord | undefined>
  findUserByIdentity(
    provider: OAuthProviderName,
    providerSubject: string,
  ): Promise<AccountUser | undefined>
  updateUserDisplayName(
    userId: string,
    displayName: string,
  ): Promise<AccountUser | undefined>
  createPendingOAuthUser(input: {
    userId: string
    identityId: string
    provider: OAuthProviderName
    providerSubject: string
    verifiedAt: Date
    email?: string | undefined
    emailVerified?: boolean | undefined
  }): Promise<AccountUser>
  createSignupSession(input: {
    id: string
    tokenHash: string
    userId: string
    createdAt: Date
    expiresAt: Date
  }): Promise<void>
  resolveSignupSession(tokenHash: string, now: Date): Promise<AccountUser | undefined>
  revokeSignupSession(tokenHash: string, now: Date): Promise<void>
  findOrCreatePendingDirectEmail(email: string): Promise<{
    user: AccountUser
    userEmailId: string
    loginEnabled: boolean
  }>
  getEligibleEmailChallenge(
    email: string,
    purpose: EmailChallengePurpose,
    now: Date,
  ): Promise<EmailChallengeRecord | undefined>
  createEmailChallenge(record: EmailChallengeRecord): Promise<void>
  abandonEmailChallenge(input: {
    challengeId: string
    now: Date
  }): Promise<boolean>
  verifyEmailChallenge(input: {
    email: string
    purpose: EmailChallengePurpose
    codeDigest: string
    now: Date
  }): Promise<EmailChallengeRecord | undefined>
  getConsumedEmailChallenge(
    challengeId: string,
    email: string,
    purpose: EmailChallengePurpose,
  ): Promise<EmailChallengeRecord | undefined>
  createEmailCredential(input: {
    challengeId: string
    email: string
    passwordHash: string
    now: Date
  }): Promise<AccountUser>
  findEmailCredential(email: string): Promise<
    | {
        user: AccountUser
        passwordHash: string
      }
    | undefined
  >
  listCurrentLegalDocuments(
    locale: string,
    asOf: Date,
  ): Promise<CurrentLegalDocument[]>
  recordSignupConsents(input: {
    userId: string
    locale: string
    applicableDocumentTypes: ReadonlyArray<LegalDocumentType>
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
    decisions: ReadonlyArray<{
      id: string
      legalDocumentId: string
      action: 'accepted' | 'withdrawn'
    }>
    now: Date
  }): Promise<void>
  completeSignup(input: {
    userId: string
    signupTokenHash: string
    now: Date
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
  }): Promise<AccountUser | undefined>
}

const toAccountUser = (row: {
  id: string
  display_name: string
  status: UserStatus
}): AccountUser => ({
  id: row.id,
  displayName: row.display_name,
  status: row.status,
})

type OAuthTransactionRow = {
  id: string
  provider: OAuthProviderName
  intent: OAuthIntent
  state_hash: string
  nonce_hash: string | null
  pkce_verifier_ciphertext: Buffer | null
  authenticated_user_id: string | null
  return_path: string
  created_at: Date
  expires_at: Date
  consumed_at: Date | null
}

const toOAuthTransaction = (
  row: OAuthTransactionRow,
): OAuthTransactionRecord => ({
  id: row.id,
  provider: row.provider,
  intent: row.intent,
  stateHash: row.state_hash,
  nonceHash: row.nonce_hash ?? undefined,
  pkceVerifierCiphertext: row.pkce_verifier_ciphertext ?? undefined,
  authenticatedUserId: row.authenticated_user_id ?? undefined,
  returnPath: row.return_path,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at ?? undefined,
})

type EmailChallengeRow = {
  id: string
  user_email_id: string
  normalized_email: string
  purpose: EmailChallengePurpose
  code_digest: string
  created_at: Date
  expires_at: Date
  resend_after: Date
  attempts: number
  max_attempts: number
  consumed_at: Date | null
}

const toEmailChallenge = (row: EmailChallengeRow): EmailChallengeRecord => ({
  id: row.id,
  userEmailId: row.user_email_id,
  email: row.normalized_email,
  purpose: row.purpose,
  codeDigest: row.code_digest,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  resendAfter: row.resend_after,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  consumedAt: row.consumed_at ?? undefined,
})

export class PostgresAccountAuthStore implements AccountAuthStore {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async createOAuthTransaction(record: OAuthTransactionRecord) {
    await this.pool.query(
      `
        INSERT INTO web_private.oauth_transactions (
          id,
          provider,
          intent,
          state_hash,
          nonce_hash,
          pkce_verifier_ciphertext,
          authenticated_user_id,
          return_path,
          created_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        record.id,
        record.provider,
        record.intent,
        record.stateHash,
        record.nonceHash,
        record.pkceVerifierCiphertext,
        record.authenticatedUserId,
        record.returnPath,
        record.createdAt,
        record.expiresAt,
      ],
    )
  }

  async consumeOAuthTransaction(stateHash: string, _now: Date) {
    const result = await this.pool.query<OAuthTransactionRow>(
      `
        SELECT *
        FROM web_private.consume_oauth_transaction($1)
      `,
      [stateHash],
    )
    const row = result.rows[0]
    return row ? toOAuthTransaction(row) : undefined
  }

  async findUserByIdentity(
    provider: OAuthProviderName,
    providerSubject: string,
  ) {
    const result = await this.pool.query<{
      id: string
      display_name: string
      status: UserStatus
    }>(
      `
        SELECT u.id, u.display_name, u.status
        FROM web_private.auth_identities identity_record
        JOIN web_private.users u ON u.id = identity_record.user_id
        WHERE identity_record.provider = $1
          AND identity_record.provider_subject = $2
      `,
      [provider, providerSubject],
    )
    const row = result.rows[0]
    return row ? toAccountUser(row) : undefined
  }

  async updateUserDisplayName(userId: string, displayName: string) {
    const result = await this.pool.query<{
      id: string
      display_name: string
      status: UserStatus
    }>(
      `
        UPDATE web_private.users
        SET display_name = $2,
            updated_at = now()
        WHERE id = $1
          AND status = 'active'
        RETURNING id, display_name, status
      `,
      [userId, displayName],
    )
    const row = result.rows[0]
    return row ? toAccountUser(row) : undefined
  }

  async createPendingOAuthUser(input: {
    userId: string
    identityId: string
    provider: OAuthProviderName
    providerSubject: string
    verifiedAt: Date
    email?: string | undefined
    emailVerified?: boolean | undefined
  }) {
    return this.#transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([input.provider, input.providerSubject])],
      )
      const existing = await this.#findIdentityUser(
        client,
        input.provider,
        input.providerSubject,
      )
      if (existing) {
        return toAccountUser(existing)
      }

      await client.query(
        `
          INSERT INTO web_private.users (id, display_name)
          VALUES ($1, 'GIWA 사용자')
        `,
        [input.userId],
      )
      await client.query(
        `
          INSERT INTO web_private.auth_identities (
            id,
            user_id,
            provider,
            provider_subject,
            verified_at
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        [
          input.identityId,
          input.userId,
          input.provider,
          input.providerSubject,
          input.verifiedAt,
        ],
      )
      if (input.email) {
        await client.query(
          `
            INSERT INTO web_private.user_emails (
              id,
              user_id,
              auth_identity_id,
              normalized_email,
              source,
              provider_verified_at,
              login_enabled,
              is_primary
            ) VALUES ($1, $2, $3, $4, $5, $6, false, true)
          `,
          [
            randomUUID(),
            input.userId,
            input.identityId,
            input.email,
            input.provider,
            input.emailVerified ? input.verifiedAt : null,
          ],
        )
      }

      return {
        id: input.userId,
        displayName: 'GIWA 사용자',
        status: 'pending' as const,
      }
    })
  }

  async createSignupSession(input: {
    id: string
    tokenHash: string
    userId: string
    createdAt: Date
    expiresAt: Date
  }) {
    await this.pool.query(
      `
        INSERT INTO web_private.signup_sessions (
          id,
          token_hash,
          user_id,
          created_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5)
      `,
      [input.id, input.tokenHash, input.userId, input.createdAt, input.expiresAt],
    )
  }

  async resolveSignupSession(tokenHash: string, now: Date) {
    const result = await this.pool.query<{
      id: string
      display_name: string
      status: UserStatus
    }>(
      `
        SELECT u.id, u.display_name, u.status
        FROM web_private.signup_sessions signup_session
        JOIN web_private.users u ON u.id = signup_session.user_id
        WHERE signup_session.token_hash = $1
          AND signup_session.expires_at > $2
          AND signup_session.completed_at IS NULL
          AND signup_session.revoked_at IS NULL
          AND u.status = 'pending'
      `,
      [tokenHash, now],
    )
    const row = result.rows[0]
    return row ? toAccountUser(row) : undefined
  }

  async revokeSignupSession(tokenHash: string, now: Date) {
    await this.pool.query(
      `
        UPDATE web_private.signup_sessions
        SET revoked_at = $2
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND completed_at IS NULL
      `,
      [tokenHash, now],
    )
  }

  async findOrCreatePendingDirectEmail(email: string) {
    return this.#transaction(async (client) => {
      // Serialize direct-email creation without granting the runtime role DELETE
      // on users. The database partial unique index remains the final guard.
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [email],
      )
      const existing = await this.#findDirectEmail(client, email)
      if (existing) {
        return {
          user: toAccountUser(existing),
          userEmailId: existing.user_email_id,
          loginEnabled: existing.login_enabled,
        }
      }

      const userId = randomUUID()
      const userEmailId = randomUUID()
      await client.query(
        `
          INSERT INTO web_private.users (id, display_name)
          VALUES ($1, 'GIWA 사용자')
        `,
        [userId],
      )
      await client.query(
        `
          INSERT INTO web_private.user_emails (
            id,
            user_id,
            normalized_email,
            source,
            login_enabled,
            is_primary
          ) VALUES ($1, $2, $3, 'email', false, true)
        `,
        [userEmailId, userId, email],
      )

      const user: AccountUser = {
        id: userId,
        displayName: 'GIWA 사용자',
        status: 'pending',
      }
      return {
        user,
        userEmailId,
        loginEnabled: false,
      }
    })
  }

  async getEligibleEmailChallenge(
    email: string,
    purpose: EmailChallengePurpose,
    now: Date,
  ) {
    const result = await this.pool.query<EmailChallengeRow>(
      `
        SELECT
          challenge.id,
          challenge.user_email_id,
          user_email.normalized_email,
          challenge.purpose,
          challenge.code_digest,
          challenge.created_at,
          challenge.expires_at,
          challenge.resend_after,
          challenge.attempts,
          challenge.max_attempts,
          challenge.consumed_at
        FROM web_private.email_verification_challenges challenge
        JOIN web_private.user_emails user_email
          ON user_email.id = challenge.user_email_id
        WHERE user_email.normalized_email = $1
          AND user_email.source = 'email'
          AND user_email.status = 'active'
          AND challenge.purpose = $2
          AND challenge.consumed_at IS NULL
          AND challenge.expires_at > $3
          AND challenge.attempts < challenge.max_attempts
        ORDER BY challenge.created_at DESC, challenge.id DESC
        LIMIT 1
      `,
      [email, purpose, now],
    )
    const row = result.rows[0]
    return row ? toEmailChallenge(row) : undefined
  }

  async createEmailChallenge(record: EmailChallengeRecord) {
    await this.pool.query(
      `
        INSERT INTO web_private.email_verification_challenges (
          id,
          user_email_id,
          purpose,
          code_digest,
          created_at,
          expires_at,
          resend_after,
          attempts,
          max_attempts,
          consumed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        record.id,
        record.userEmailId,
        record.purpose,
        record.codeDigest,
        record.createdAt,
        record.expiresAt,
        record.resendAfter,
        record.attempts,
        record.maxAttempts,
        record.consumedAt,
      ],
    )
  }

  async abandonEmailChallenge(input: { challengeId: string; now: Date }) {
    const result = await this.pool.query(
      `
        UPDATE web_private.email_verification_challenges
        SET attempts = max_attempts
        WHERE id = $1
          AND consumed_at IS NULL
      `,
      [input.challengeId],
    )
    return result.rowCount === 1
  }

  async verifyEmailChallenge(input: {
    email: string
    purpose: EmailChallengePurpose
    codeDigest: string
    now: Date
  }) {
    return this.#transaction(async (client) => {
      const selected = await client.query<EmailChallengeRow>(
        `
          SELECT
            challenge.id,
            challenge.user_email_id,
            user_email.normalized_email,
            challenge.purpose,
            challenge.code_digest,
            challenge.created_at,
            challenge.expires_at,
            challenge.resend_after,
            challenge.attempts,
            challenge.max_attempts,
            challenge.consumed_at
          FROM web_private.email_verification_challenges challenge
          JOIN web_private.user_emails user_email
            ON user_email.id = challenge.user_email_id
          WHERE user_email.normalized_email = $1
            AND user_email.source = 'email'
            AND user_email.status = 'active'
            AND challenge.purpose = $2
            AND challenge.consumed_at IS NULL
            AND challenge.expires_at > $3
            AND challenge.attempts < challenge.max_attempts
          ORDER BY challenge.created_at DESC, challenge.id DESC
          LIMIT 1
          FOR UPDATE OF challenge
        `,
        [input.email, input.purpose, input.now],
      )
      const row = selected.rows[0]
      if (
        !row ||
        row.consumed_at ||
        row.expires_at.getTime() <= input.now.getTime() ||
        row.attempts >= row.max_attempts
      ) {
        return undefined
      }

      const valid = row.code_digest === input.codeDigest
      const updated = await client.query<EmailChallengeRow>(
        `
          UPDATE web_private.email_verification_challenges challenge
          SET
            attempts = challenge.attempts + 1,
            consumed_at = CASE
              WHEN $3::boolean THEN $2::timestamptz
              ELSE NULL
            END
          FROM web_private.user_emails user_email
          WHERE challenge.id = $1
            AND user_email.id = challenge.user_email_id
          RETURNING
            challenge.id,
            challenge.user_email_id,
            user_email.normalized_email,
            challenge.purpose,
            challenge.code_digest,
            challenge.created_at,
            challenge.expires_at,
            challenge.resend_after,
            challenge.attempts,
            challenge.max_attempts,
            challenge.consumed_at
        `,
        [row.id, input.now, valid],
      )
      const updatedRow = updated.rows[0]
      if (!updatedRow || !valid) {
        return undefined
      }
      await client.query(
        `
          UPDATE web_private.user_emails
          SET giwa_verified_at = $2
          WHERE id = $1
        `,
        [row.user_email_id, input.now],
      )
      return toEmailChallenge(updatedRow)
    })
  }

  async getConsumedEmailChallenge(
    challengeId: string,
    email: string,
    purpose: EmailChallengePurpose,
  ) {
    const result = await this.pool.query<EmailChallengeRow>(
      `
        SELECT
          challenge.id,
          challenge.user_email_id,
          user_email.normalized_email,
          challenge.purpose,
          challenge.code_digest,
          challenge.created_at,
          challenge.expires_at,
          challenge.resend_after,
          challenge.attempts,
          challenge.max_attempts,
          challenge.consumed_at
        FROM web_private.email_verification_challenges challenge
        JOIN web_private.user_emails user_email
          ON user_email.id = challenge.user_email_id
        WHERE challenge.id = $1
          AND user_email.normalized_email = $2
          AND challenge.purpose = $3
          AND challenge.consumed_at IS NOT NULL
          AND user_email.giwa_verified_at IS NOT NULL
      `,
      [challengeId, email, purpose],
    )
    const row = result.rows[0]
    return row ? toEmailChallenge(row) : undefined
  }

  async createEmailCredential(input: {
    challengeId: string
    email: string
    passwordHash: string
    now: Date
  }) {
    return this.#transaction(async (client) => {
      const selected = await client.query<{
        user_email_id: string
        user_id: string
        id: string
        display_name: string
        status: UserStatus
      }>(
        `
          SELECT
            user_email.id AS user_email_id,
            user_email.user_id,
            u.id,
            u.display_name,
            u.status
          FROM web_private.email_verification_challenges challenge
          JOIN web_private.user_emails user_email
            ON user_email.id = challenge.user_email_id
          JOIN web_private.users u ON u.id = user_email.user_id
          WHERE challenge.id = $1
            AND challenge.purpose = 'signup'
            AND challenge.consumed_at IS NOT NULL
            AND user_email.normalized_email = $2
            AND user_email.giwa_verified_at IS NOT NULL
            AND user_email.source = 'email'
            AND user_email.status = 'active'
          FOR UPDATE OF user_email, u
        `,
        [input.challengeId, input.email],
      )
      const row = selected.rows[0]
      if (!row) {
        throw new Error('Verified direct email challenge could not be loaded')
      }
      if (row.status !== 'pending') {
        throw new Error('Direct email user is not pending')
      }

      await client.query(
        `
          INSERT INTO web_private.email_credentials (
            user_email_id,
            password_hash,
            password_algorithm,
            created_at,
            password_updated_at
          ) VALUES ($1, $2, 'argon2id', $3, $3)
        `,
        [row.user_email_id, input.passwordHash, input.now],
      )
      await client.query(
        `
          UPDATE web_private.user_emails
          SET login_enabled = true
          WHERE id = $1
        `,
        [row.user_email_id],
      )
      return toAccountUser(row)
    })
  }

  async findEmailCredential(email: string) {
    const result = await this.pool.query<{
      id: string
      display_name: string
      status: UserStatus
      password_hash: string
    }>(
      `
        SELECT u.id, u.display_name, u.status, credential.password_hash
        FROM web_private.user_emails user_email
        JOIN web_private.users u ON u.id = user_email.user_id
        JOIN web_private.email_credentials credential
          ON credential.user_email_id = user_email.id
        WHERE user_email.normalized_email = $1
          AND user_email.source = 'email'
          AND user_email.status = 'active'
          AND user_email.login_enabled
      `,
      [email],
    )
    const row = result.rows[0]
    return row
      ? { user: toAccountUser(row), passwordHash: row.password_hash }
      : undefined
  }

  async listCurrentLegalDocuments(locale: string, asOf: Date) {
    const result = await this.pool.query<{
      id: string
      document_type: LegalDocumentType
      locale: string
      version: string
      content_hash: string
      content: string
      effective_at: Date
    }>(
      `
        SELECT DISTINCT ON (document.document_type)
          document.id,
          document.document_type,
          document.locale,
          document.version,
          document.content_hash,
          content_record.content,
          document.effective_at
        FROM web_private.legal_documents document
        JOIN web_private.legal_document_contents content_record
          ON content_record.legal_document_id = document.id
        WHERE document.locale = $1
          AND document.effective_at <= $2
        ORDER BY
          document.document_type,
          document.effective_at DESC,
          document.version DESC,
          document.id DESC
      `,
      [locale, asOf],
    )
    return result.rows.map((row) => ({
      id: row.id,
      documentType: row.document_type,
      locale: row.locale,
      version: row.version,
      contentHash: row.content_hash,
      content: row.content,
      effectiveAt: row.effective_at,
    }))
  }

  async recordSignupConsents(input: {
    userId: string
    locale: string
    applicableDocumentTypes: ReadonlyArray<LegalDocumentType>
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
    decisions: ReadonlyArray<{
      id: string
      legalDocumentId: string
      action: 'accepted' | 'withdrawn'
    }>
    now: Date
  }) {
    await this.#transaction(async (client) => {
      const current = await client.query<{
        id: string
        document_type: LegalDocumentType
      }>(
        `
          SELECT DISTINCT ON (document.document_type)
            document.id,
            document.document_type
          FROM web_private.legal_documents document
          JOIN web_private.legal_document_contents content_record
            ON content_record.legal_document_id = document.id
          WHERE document.locale = $1
            AND document.effective_at <= $2
            AND document.document_type::text = ANY($3::text[])
          ORDER BY
            document.document_type,
            document.effective_at DESC,
            document.version DESC,
            document.id DESC
        `,
        [input.locale, input.now, input.applicableDocumentTypes],
      )
      const currentById = new Map(
        current.rows.map((document) => [document.id, document.document_type]),
      )
      const acceptedTypes = new Set<LegalDocumentType>()
      const decidedDocumentIds = new Set<string>()
      for (const decision of input.decisions) {
        const type = currentById.get(decision.legalDocumentId)
        if (!type) {
          throw new Error('Consent references a non-current legal document')
        }
        if (decidedDocumentIds.has(decision.legalDocumentId)) {
          throw new Error('Consent contains duplicate legal document decisions')
        }
        decidedDocumentIds.add(decision.legalDocumentId)
        if (decision.action === 'accepted') {
          acceptedTypes.add(type)
        }
      }
      if (decidedDocumentIds.size !== currentById.size) {
        throw new Error('Consent must decide every current legal document')
      }
      for (const required of input.requiredDocumentTypes) {
        if (!acceptedTypes.has(required)) {
          throw new Error(`Required legal document was not accepted: ${required}`)
        }
      }

      for (const decision of input.decisions) {
        await client.query(
          `
            INSERT INTO web_private.user_consents (
              id,
              user_id,
              legal_document_id,
              action
            ) VALUES ($1, $2, $3, $4)
          `,
          [
            decision.id,
            input.userId,
            decision.legalDocumentId,
            decision.action,
          ],
        )
      }
    })
  }

  async completeSignup(input: {
    userId: string
    signupTokenHash: string
    now: Date
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
  }): Promise<AccountUser | undefined> {
    return this.#transaction(async (client) => {
      const pending = await client.query<{
        id: string
        display_name: string
        status: UserStatus
      }>(
        `
          SELECT u.id, u.display_name, u.status
          FROM web_private.signup_sessions signup_session
          JOIN web_private.users u ON u.id = signup_session.user_id
          WHERE signup_session.token_hash = $1
            AND signup_session.user_id = $2
            AND signup_session.expires_at > $3
            AND signup_session.completed_at IS NULL
            AND signup_session.revoked_at IS NULL
            AND u.status = 'pending'
          FOR UPDATE OF signup_session, u
        `,
        [input.signupTokenHash, input.userId, input.now],
      )
      const row = pending.rows[0]
      if (!row) {
        return undefined
      }

      const requiredConsents = await client.query<{
        document_type: LegalDocumentType
        action: 'accepted' | 'withdrawn' | null
      }>(
        `
          WITH current_documents AS (
            SELECT DISTINCT ON (document.document_type)
              document.id,
              document.document_type
            FROM web_private.legal_documents document
            JOIN web_private.legal_document_contents content_record
              ON content_record.legal_document_id = document.id
            WHERE document.document_type::text = ANY($3::text[])
              AND document.locale = 'ko-KR'
              AND document.effective_at <= $2
            ORDER BY
              document.document_type,
              document.effective_at DESC,
              document.version DESC,
              document.id DESC
          )
          SELECT current_document.document_type, consent.action
          FROM current_documents current_document
          LEFT JOIN LATERAL (
            SELECT user_consent.action
            FROM web_private.user_consents user_consent
            WHERE user_consent.user_id = $1
              AND user_consent.legal_document_id = current_document.id
              AND user_consent.occurred_at <= $2
            ORDER BY user_consent.occurred_at DESC, user_consent.id DESC
            LIMIT 1
          ) consent ON true
        `,
        [input.userId, input.now, input.requiredDocumentTypes],
      )
      const acceptedTypes = new Set(
        requiredConsents.rows
          .filter((consent) => consent.action === 'accepted')
          .map((consent) => consent.document_type),
      )
      if (
        input.requiredDocumentTypes.some(
          (documentType) => !acceptedTypes.has(documentType),
        )
      ) {
        throw new Error('Required legal documents were not accepted')
      }

      const activated = await client.query<{ changed: boolean }>(
        'SELECT web_private.set_user_status($1::uuid, $2) AS changed',
        [input.userId, 'active'],
      )
      if (activated.rows[0]?.changed !== true) {
        return undefined
      }
      await client.query(
        `
          UPDATE web_private.signup_sessions
          SET completed_at = $3
          WHERE token_hash = $1
            AND user_id = $2
            AND completed_at IS NULL
            AND revoked_at IS NULL
        `,
        [input.signupTokenHash, input.userId, input.now],
      )
      return { ...toAccountUser(row), status: 'active' }
    })
  }

  async #findIdentityUser(
    client: PoolClient,
    provider: OAuthProviderName,
    providerSubject: string,
  ) {
    const result = await client.query<{
      id: string
      display_name: string
      status: UserStatus
    }>(
      `
        SELECT u.id, u.display_name, u.status
        FROM web_private.auth_identities identity_record
        JOIN web_private.users u ON u.id = identity_record.user_id
        WHERE identity_record.provider = $1
          AND identity_record.provider_subject = $2
      `,
      [provider, providerSubject],
    )
    return result.rows[0]
  }

  async #findDirectEmail(client: PoolClient, email: string) {
    const result = await client.query<{
      id: string
      display_name: string
      status: UserStatus
      user_email_id: string
      login_enabled: boolean
    }>(
      `
        SELECT
          u.id,
          u.display_name,
          u.status,
          user_email.id AS user_email_id,
          user_email.login_enabled
        FROM web_private.user_emails user_email
        JOIN web_private.users u ON u.id = user_email.user_id
        WHERE user_email.normalized_email = $1
          AND user_email.source = 'email'
          AND user_email.status = 'active'
        FOR UPDATE OF user_email, u
      `,
      [email],
    )
    return result.rows[0]
  }

  async #transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

export class MemoryAccountAuthStore implements AccountAuthStore {
  readonly durable: boolean = false
  readonly #oauthTransactions = new Map<string, OAuthTransactionRecord>()
  readonly #users = new Map<string, AccountUser>()
  readonly #identities = new Map<string, string>()
  readonly #signupSessions = new Map<
    string,
    { userId: string; expiresAt: Date; revokedAt?: Date; completedAt?: Date }
  >()
  readonly #emails = new Map<
    string,
    {
      id: string
      userId: string
      loginEnabled: boolean
      giwaVerifiedAt?: Date
      passwordHash?: string
    }
  >()
  readonly #emailChallenges = new Map<string, EmailChallengeRecord>()
  readonly #legalDocuments = new Map<string, CurrentLegalDocument>()
  readonly #consents: Array<{
    userId: string
    legalDocumentId: string
    action: 'accepted' | 'withdrawn'
  }> = []

  async createOAuthTransaction(record: OAuthTransactionRecord) {
    this.#oauthTransactions.set(record.stateHash, { ...record })
  }

  async consumeOAuthTransaction(stateHash: string, now: Date) {
    const transaction = this.#oauthTransactions.get(stateHash)
    if (
      !transaction ||
      transaction.consumedAt ||
      transaction.expiresAt.getTime() <= now.getTime()
    ) {
      return undefined
    }
    const consumed = { ...transaction, consumedAt: now }
    this.#oauthTransactions.set(stateHash, consumed)
    return consumed
  }

  async findUserByIdentity(
    provider: OAuthProviderName,
    providerSubject: string,
  ) {
    const userId = this.#identities.get(`${provider}\0${providerSubject}`)
    return userId ? this.#users.get(userId) : undefined
  }

  async updateUserDisplayName(userId: string, displayName: string) {
    const user = this.#users.get(userId)
    if (!user || user.status !== 'active') return undefined
    const updated = { ...user, displayName }
    this.#users.set(userId, updated)
    return updated
  }

  async createPendingOAuthUser(input: {
    userId: string
    identityId: string
    provider: OAuthProviderName
    providerSubject: string
    verifiedAt: Date
    email?: string | undefined
    emailVerified?: boolean | undefined
  }) {
    const identityKey = `${input.provider}\0${input.providerSubject}`
    const existingUserId = this.#identities.get(identityKey)
    if (existingUserId) {
      const existing = this.#users.get(existingUserId)
      if (!existing) {
        throw new Error('Identity references a missing memory user')
      }
      return existing
    }
    const user: AccountUser = {
      id: input.userId,
      displayName: 'GIWA 사용자',
      status: 'pending',
    }
    this.#users.set(user.id, user)
    this.#identities.set(identityKey, user.id)
    return user
  }

  async createSignupSession(input: {
    id: string
    tokenHash: string
    userId: string
    createdAt: Date
    expiresAt: Date
  }) {
    this.#signupSessions.set(input.tokenHash, {
      userId: input.userId,
      expiresAt: input.expiresAt,
    })
  }

  async resolveSignupSession(tokenHash: string, now: Date) {
    const session = this.#signupSessions.get(tokenHash)
    if (
      !session ||
      session.revokedAt ||
      session.completedAt ||
      session.expiresAt.getTime() <= now.getTime()
    ) {
      return undefined
    }
    const user = this.#users.get(session.userId)
    return user?.status === 'pending' ? user : undefined
  }

  async revokeSignupSession(tokenHash: string, now: Date) {
    const session = this.#signupSessions.get(tokenHash)
    if (session) {
      session.revokedAt = now
    }
  }

  async findOrCreatePendingDirectEmail(email: string) {
    const existing = this.#emails.get(email)
    if (existing) {
      const user = this.#users.get(existing.userId)
      if (!user) {
        throw new Error('Email references a missing memory user')
      }
      return { user, userEmailId: existing.id, loginEnabled: existing.loginEnabled }
    }
    const user: AccountUser = {
      id: randomUUID(),
      displayName: 'GIWA 사용자',
      status: 'pending',
    }
    const emailRecord = {
      id: randomUUID(),
      userId: user.id,
      loginEnabled: false,
    }
    this.#users.set(user.id, user)
    this.#emails.set(email, emailRecord)
    return { user, userEmailId: emailRecord.id, loginEnabled: false }
  }

  async getEligibleEmailChallenge(
    email: string,
    purpose: EmailChallengePurpose,
    now: Date,
  ) {
    return [...this.#emailChallenges.values()]
      .filter(
        (challenge) =>
          challenge.email === email &&
          challenge.purpose === purpose &&
          !challenge.consumedAt &&
          challenge.expiresAt.getTime() > now.getTime() &&
          challenge.attempts < challenge.maxAttempts,
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
  }

  async createEmailChallenge(record: EmailChallengeRecord) {
    this.#emailChallenges.set(record.id, { ...record })
  }

  async abandonEmailChallenge(input: { challengeId: string; now: Date }) {
    const challenge = this.#emailChallenges.get(input.challengeId)
    if (!challenge || challenge.consumedAt) {
      return false
    }
    this.#emailChallenges.set(input.challengeId, {
      ...challenge,
      attempts: challenge.maxAttempts,
    })
    return true
  }

  async verifyEmailChallenge(input: {
    email: string
    purpose: EmailChallengePurpose
    codeDigest: string
    now: Date
  }) {
    const challenge = await this.getEligibleEmailChallenge(
      input.email,
      input.purpose,
      input.now,
    )
    if (!challenge) {
      return undefined
    }
    const updated = {
      ...challenge,
      attempts: challenge.attempts + 1,
      ...(challenge.codeDigest === input.codeDigest
        ? { consumedAt: input.now }
        : {}),
    }
    this.#emailChallenges.set(challenge.id, updated)
    if (challenge.codeDigest !== input.codeDigest) {
      return undefined
    }
    const email = this.#emails.get(input.email)
    if (email) {
      email.giwaVerifiedAt = input.now
    }
    return updated
  }

  async getConsumedEmailChallenge(
    challengeId: string,
    email: string,
    purpose: EmailChallengePurpose,
  ) {
    const challenge = this.#emailChallenges.get(challengeId)
    return challenge?.email === email &&
      challenge.purpose === purpose &&
      challenge.consumedAt
      ? challenge
      : undefined
  }

  async createEmailCredential(input: {
    challengeId: string
    email: string
    passwordHash: string
    now: Date
  }) {
    const challenge = await this.getConsumedEmailChallenge(
      input.challengeId,
      input.email,
      'signup',
    )
    const email = this.#emails.get(input.email)
    const user = email ? this.#users.get(email.userId) : undefined
    if (!challenge || !email?.giwaVerifiedAt || !user || user.status !== 'pending') {
      throw new Error('Verified direct email challenge could not be loaded')
    }
    if (email.loginEnabled || email.passwordHash) {
      throw new Error('Direct email credential already exists')
    }
    email.loginEnabled = true
    email.passwordHash = input.passwordHash
    return user
  }

  async findEmailCredential(email: string) {
    const emailRecord = this.#emails.get(email)
    const user = emailRecord ? this.#users.get(emailRecord.userId) : undefined
    return emailRecord?.loginEnabled && emailRecord.passwordHash && user
      ? { user, passwordHash: emailRecord.passwordHash }
      : undefined
  }

  async listCurrentLegalDocuments(locale: string, asOf: Date) {
    const currentByType = new Map<LegalDocumentType, CurrentLegalDocument>()
    const candidates = [...this.#legalDocuments.values()]
      .filter(
        (document) =>
          document.locale === locale &&
          document.effectiveAt.getTime() <= asOf.getTime(),
      )
      .sort((left, right) => {
        const effectiveDifference =
          right.effectiveAt.getTime() - left.effectiveAt.getTime()
        return effectiveDifference || right.version.localeCompare(left.version)
      })
    for (const document of candidates) {
      if (!currentByType.has(document.documentType)) {
        currentByType.set(document.documentType, document)
      }
    }
    return [...currentByType.values()]
  }

  async recordSignupConsents(input: {
    userId: string
    locale: string
    applicableDocumentTypes: ReadonlyArray<LegalDocumentType>
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
    decisions: ReadonlyArray<{
      id: string
      legalDocumentId: string
      action: 'accepted' | 'withdrawn'
    }>
    now: Date
  }) {
    const applicableTypes = new Set(input.applicableDocumentTypes)
    const current = (
      await this.listCurrentLegalDocuments(input.locale, input.now)
    ).filter((document) => applicableTypes.has(document.documentType))
    const currentById = new Map(
      current.map((document) => [document.id, document.documentType]),
    )
    const accepted = new Set<LegalDocumentType>()
    const decidedDocumentIds = new Set<string>()
    for (const decision of input.decisions) {
      const type = currentById.get(decision.legalDocumentId)
      if (!type) {
        throw new Error('Consent references a non-current legal document')
      }
      if (decidedDocumentIds.has(decision.legalDocumentId)) {
        throw new Error('Consent contains duplicate legal document decisions')
      }
      decidedDocumentIds.add(decision.legalDocumentId)
      if (decision.action === 'accepted') {
        accepted.add(type)
      }
    }
    if (decidedDocumentIds.size !== currentById.size) {
      throw new Error('Consent must decide every current legal document')
    }
    for (const required of input.requiredDocumentTypes) {
      if (!accepted.has(required)) {
        throw new Error(`Required legal document was not accepted: ${required}`)
      }
    }
    this.#consents.push(
      ...input.decisions.map((decision) => ({
        userId: input.userId,
        legalDocumentId: decision.legalDocumentId,
        action: decision.action,
      })),
    )
  }

  async completeSignup(input: {
    userId: string
    signupTokenHash: string
    now: Date
    requiredDocumentTypes: ReadonlyArray<LegalDocumentType>
  }) {
    const session = this.#signupSessions.get(input.signupTokenHash)
    const user = this.#users.get(input.userId)
    if (
      !session ||
      session.userId !== input.userId ||
      session.revokedAt ||
      session.completedAt ||
      session.expiresAt.getTime() <= input.now.getTime() ||
      user?.status !== 'pending'
    ) {
      return undefined
    }
    const acceptedIds = new Set(
      this.#consents
        .filter(
          (consent) =>
            consent.userId === input.userId && consent.action === 'accepted',
        )
        .map((consent) => consent.legalDocumentId),
    )
    const currentDocuments = await this.listCurrentLegalDocuments(
      'ko-KR',
      input.now,
    )
    const acceptedTypes = new Set(
      currentDocuments
        .filter((document) => acceptedIds.has(document.id))
        .map((document) => document.documentType),
    )
    if (
      input.requiredDocumentTypes.some(
        (documentType) => !acceptedTypes.has(documentType),
      )
    ) {
      throw new Error('Required legal documents were not accepted')
    }
    session.completedAt = input.now
    const activeUser: AccountUser = { ...user, status: 'active' }
    this.#users.set(user.id, activeUser)
    return activeUser
  }

  seedUser(user: AccountUser) {
    this.#users.set(user.id, user)
  }

  setUserStatus(userId: string, status: UserStatus) {
    const user = this.#users.get(userId)
    if (!user) {
      throw new Error('Memory user does not exist')
    }
    this.#users.set(userId, { ...user, status })
  }

  linkIdentity(provider: OAuthProviderName, providerSubject: string, userId: string) {
    this.#identities.set(`${provider}\0${providerSubject}`, userId)
  }

  seedLegalDocument(document: CurrentLegalDocument) {
    this.#legalDocuments.set(document.id, document)
  }
}
