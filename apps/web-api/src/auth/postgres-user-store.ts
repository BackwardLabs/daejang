import type { Pool, PoolClient } from 'pg'

export type UserStatus = 'pending' | 'active' | 'suspended' | 'deleted'
export type ConsentAction = 'accepted' | 'withdrawn'
export type LegalDocumentType =
  | 'terms'
  | 'privacy'
  | 'identity_verification'
  | 'marketing'

export type UserRecord = {
  id: string
  displayName: string
  status: UserStatus
  sessionEpoch: number
  createdAt: Date
  updatedAt: Date
}

export type AuthIdentityRecord = {
  id: string
  userId: string
  provider: string
  providerSubject: string
  verifiedAt: Date
  createdAt: Date
}

export type CurrentConsent = {
  legalDocument: {
    id: string
    type: LegalDocumentType
    locale: string
    version: string
    contentHash: string
    effectiveAt: Date
  }
  action: ConsentAction | undefined
  occurredAt: Date | undefined
}

type UserRow = {
  id: string
  display_name: string
  status: UserStatus
  session_epoch: string
  created_at: Date
  updated_at: Date
}

type AuthIdentityRow = {
  id: string
  user_id: string
  provider: string
  provider_subject: string
  verified_at: Date
  created_at: Date
}

type CurrentConsentRow = {
  legal_document_id: string
  document_type: LegalDocumentType
  locale: string
  version: string
  content_hash: string
  effective_at: Date
  action: ConsentAction | null
  occurred_at: Date | null
}

const parsePositiveInteger = (value: string, field: string) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is outside the JavaScript safe integer range`)
  }
  return parsed
}

const toUserRecord = (row: UserRow): UserRecord => ({
  id: row.id,
  displayName: row.display_name,
  status: row.status,
  sessionEpoch: parsePositiveInteger(row.session_epoch, 'session_epoch'),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAuthIdentityRecord = (row: AuthIdentityRow): AuthIdentityRecord => ({
  id: row.id,
  userId: row.user_id,
  provider: row.provider,
  providerSubject: row.provider_subject,
  verifiedAt: row.verified_at,
  createdAt: row.created_at,
})

export class PostgresUserStore {
  constructor(private readonly pool: Pool) {}

  async upsertUser(user: { id: string; displayName: string }) {
    const result = await this.pool.query<UserRow>(
      `
        INSERT INTO web_private.users (id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE
        SET display_name = EXCLUDED.display_name
        WHERE web_private.users.display_name IS DISTINCT FROM EXCLUDED.display_name
        RETURNING id, display_name, status, session_epoch, created_at, updated_at
      `,
      [user.id, user.displayName],
    )
    const row = result.rows[0] ?? (await this.#loadUser(user.id))
    if (!row) {
      throw new Error('Stored user could not be reloaded')
    }
    return toUserRecord(row)
  }

  async setStatus(userId: string, status: UserStatus) {
    const result = await this.pool.query<{ changed: boolean }>(
      'SELECT web_private.set_user_status($1::uuid, $2) AS changed',
      [userId, status],
    )
    if (result.rows[0]?.changed !== true) {
      return undefined
    }
    const row = await this.#loadUser(userId)
    return row ? toUserRecord(row) : undefined
  }

  async linkIdentity(input: {
    id: string
    userId: string
    provider: string
    providerSubject: string
    verifiedAt: Date
  }) {
    return this.#transaction(async (client) => {
      await client.query(
        `
          INSERT INTO web_private.auth_identities (
            id,
            user_id,
            provider,
            provider_subject,
            verified_at
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (provider, provider_subject) DO NOTHING
        `,
        [
          input.id,
          input.userId,
          input.provider,
          input.providerSubject,
          input.verifiedAt,
        ],
      )

      const identity = await this.#findIdentity(
        client,
        input.provider,
        input.providerSubject,
      )
      if (!identity) {
        throw new Error('Stored authentication identity could not be reloaded')
      }
      if (identity.user_id !== input.userId) {
        throw new Error('Authentication identity is already linked to another user')
      }
      return toAuthIdentityRecord(identity)
    })
  }

  async findUserByIdentity(provider: string, providerSubject: string) {
    const result = await this.pool.query<UserRow>(
      `
        SELECT u.id, u.display_name, u.status, u.session_epoch, u.created_at, u.updated_at
        FROM web_private.auth_identities ai
        JOIN web_private.users u ON u.id = ai.user_id
        WHERE ai.provider = $1 AND ai.provider_subject = $2
      `,
      [provider, providerSubject],
    )
    const row = result.rows[0]
    return row ? toUserRecord(row) : undefined
  }

  async recordConsent(input: {
    id: string
    userId: string
    legalDocumentId: string
    action: ConsentAction
  }) {
    const result = await this.pool.query<{ occurred_at: Date }>(
      `
        INSERT INTO web_private.user_consents (
          id,
          user_id,
          legal_document_id,
          action
        ) VALUES ($1, $2, $3, $4)
        RETURNING occurred_at
      `,
      [input.id, input.userId, input.legalDocumentId, input.action],
    )
    const occurredAt = result.rows[0]?.occurred_at
    if (!occurredAt) {
      throw new Error('PostgreSQL did not return the consent occurrence time')
    }
    return { ...input, occurredAt }
  }

  async getCurrentConsent(
    userId: string,
    documentType: LegalDocumentType,
    locale: string,
    asOf: Date = new Date(),
  ): Promise<CurrentConsent | undefined> {
    const result = await this.pool.query<CurrentConsentRow>(
      `
        SELECT
          document.id AS legal_document_id,
          document.document_type,
          document.locale,
          document.version,
          document.content_hash,
          document.effective_at,
          consent.action,
          consent.occurred_at
        FROM web_private.users user_record
        JOIN LATERAL (
          SELECT id, document_type, locale, version, content_hash, effective_at
          FROM web_private.legal_documents
          WHERE document_type = $2
            AND locale = $3
            AND effective_at <= $4
          ORDER BY effective_at DESC, version DESC, id DESC
          LIMIT 1
        ) AS document ON true
        LEFT JOIN LATERAL (
          SELECT action, occurred_at
          FROM web_private.user_consents
          WHERE user_id = $1
            AND legal_document_id = document.id
            AND occurred_at <= $4
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1
        ) AS consent ON true
        WHERE user_record.id = $1
      `,
      [userId, documentType, locale, asOf],
    )
    const row = result.rows[0]
    if (!row) {
      return undefined
    }
    return {
      legalDocument: {
        id: row.legal_document_id,
        type: row.document_type,
        locale: row.locale,
        version: row.version,
        contentHash: row.content_hash,
        effectiveAt: row.effective_at,
      },
      action: row.action ?? undefined,
      occurredAt: row.occurred_at ?? undefined,
    }
  }

  async #loadUser(userId: string) {
    const result = await this.pool.query<UserRow>(
      `
        SELECT id, display_name, status, session_epoch, created_at, updated_at
        FROM web_private.users
        WHERE id = $1
      `,
      [userId],
    )
    return result.rows[0]
  }

  async #findIdentity(client: PoolClient, provider: string, providerSubject: string) {
    const result = await client.query<AuthIdentityRow>(
      `
        SELECT id, user_id, provider, provider_subject, verified_at, created_at
        FROM web_private.auth_identities
        WHERE provider = $1 AND provider_subject = $2
      `,
      [provider, providerSubject],
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
