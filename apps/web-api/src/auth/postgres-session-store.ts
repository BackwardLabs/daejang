import type { Pool, PoolClient } from 'pg'

import type { SessionRecord, SessionStore } from './session.js'

type SessionTransition = Parameters<SessionStore['resolveAndTouch']>[0]
type RotateSessionTransition = Parameters<SessionStore['rotate']>[0]

type SessionRow = {
  id: string
  user_id: string
  display_name: string
  email: string | null
  subject_name_claim_id: string | null
  subject_name: string | null
  normalized_subject_name: string | null
  session_epoch: string
  created_at: Date
  last_seen_at: Date
  absolute_expires_at: Date
  idle_expires_at: Date
}

const parsePositiveInteger = (value: string, field: string) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is outside the JavaScript safe integer range`)
  }
  return parsed
}

const parseNonNegativeInteger = (value: string | undefined, field: string) => {
  if (value === undefined) {
    throw new Error(`PostgreSQL did not return ${field}`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} is outside the JavaScript safe integer range`)
  }
  return parsed
}

const normalizedSubjectName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ')

const toSessionRecord = (row: SessionRow): SessionRecord => {
  const claim = row.subject_name_claim_id
    ? {
        value: row.subject_name,
        normalizedValue: row.normalized_subject_name,
      }
    : undefined
  if (
    claim &&
    (!claim.value ||
      !claim.normalizedValue ||
      claim.normalizedValue !== normalizedSubjectName(claim.value))
  ) {
    throw new Error('Verified subject name claim is incomplete')
  }

  return {
    id: row.id,
    user: {
      id: row.user_id,
      displayName: row.display_name,
      ...(row.email ? { email: row.email } : {}),
    },
    ...(claim
      ? {
          verifiedSubjectName: {
            normalizedValue: claim.normalizedValue as string,
          },
        }
      : {}),
    sessionEpoch: parsePositiveInteger(row.session_epoch, 'session_epoch'),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    absoluteExpiresAt: row.absolute_expires_at,
    idleExpiresAt: row.idle_expires_at,
  }
}

const loadSession = async (client: PoolClient, sessionId: string) => {
  const result = await client.query<SessionRow>(
    `
      SELECT
        s.id,
        s.user_id,
        u.display_name,
        primary_email.normalized_email AS email,
        subject_claim.claim_id AS subject_name_claim_id,
        subject_claim.subject_name,
        subject_claim.normalized_name AS normalized_subject_name,
        s.session_epoch,
        s.created_at,
        s.last_seen_at,
        s.absolute_expires_at,
        s.idle_expires_at
      FROM web_private.sessions s
      JOIN web_private.users u
        ON u.id = s.user_id
        AND u.status = 'active'
        AND u.session_epoch = s.session_epoch
      LEFT JOIN web_private.subject_name_claims subject_claim
        ON subject_claim.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT user_email.normalized_email
        FROM web_private.user_emails user_email
        WHERE user_email.user_id = u.id
          AND user_email.status = 'active'
          AND user_email.is_primary = true
        LIMIT 1
      ) primary_email ON true
      WHERE s.id = $1
    `,
    [sessionId],
  )

  const row = result.rows[0]
  return row ? toSessionRecord(row) : undefined
}

export class PostgresSessionStore implements SessionStore {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async resolveAndTouch({ tokenHash, now, idleTtlMilliseconds }: SessionTransition) {
    return this.#transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `
          UPDATE web_private.sessions s
          SET
            last_seen_at = $2,
            idle_expires_at = LEAST(
              s.absolute_expires_at,
              $2::timestamptz + ($3::double precision * interval '1 millisecond')
            )
          FROM web_private.users u
          WHERE s.token_hash = $1
            AND u.id = s.user_id
            AND u.status = 'active'
            AND u.session_epoch = s.session_epoch
            AND s.absolute_expires_at > $2
            AND s.idle_expires_at > $2
          RETURNING s.id
        `,
        [tokenHash, now, idleTtlMilliseconds],
      )

      const row = result.rows[0]
      if (!row) {
        await client.query('DELETE FROM web_private.sessions WHERE token_hash = $1', [
          tokenHash,
        ])
        return undefined
      }

      const session = await loadSession(client, row.id)
      if (!session) {
        await client.query('DELETE FROM web_private.sessions WHERE id = $1', [row.id])
      }
      return session
    })
  }

  async set(tokenHash: string, session: SessionRecord) {
    return this.#transaction((client) => this.#insertSession(client, tokenHash, session))
  }

  async replaceAfterAuthentication({
    currentTokenHash,
    replacementTokenHash,
    replacement,
  }: Parameters<SessionStore['replaceAfterAuthentication']>[0]) {
    return this.#transaction(async (client) => {
      if (currentTokenHash) {
        await client.query(
          'DELETE FROM web_private.sessions WHERE token_hash = $1',
          [currentTokenHash],
        )
      }

      return this.#insertSession(client, replacementTokenHash, replacement)
    })
  }

  async #insertSession(client: PoolClient, tokenHash: string, session: SessionRecord) {
    const user = await client.query<{ session_epoch: string }>(
      `
        SELECT session_epoch
        FROM web_private.users
        WHERE id = $1 AND status = 'active'
        FOR UPDATE
      `,
      [session.user.id],
    )
    const userRow = user.rows[0]
    if (!userRow) {
      throw new Error('Active session user does not exist')
    }

    await client.query(
      `
        INSERT INTO web_private.sessions (
          id,
          token_hash,
          user_id,
          session_epoch,
          created_at,
          last_seen_at,
          absolute_expires_at,
          idle_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        session.id,
        tokenHash,
        session.user.id,
        userRow.session_epoch,
        session.createdAt,
        session.lastSeenAt,
        session.absoluteExpiresAt,
        session.idleExpiresAt,
      ],
    )

    const stored = await loadSession(client, session.id)
    if (!stored) {
      throw new Error('Stored session could not be reloaded')
    }
    return stored
  }

  async rotate({
    tokenHash,
    replacementTokenHash,
    replacementSessionId,
    now,
    idleTtlMilliseconds,
  }: RotateSessionTransition) {
    return this.#transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `
          UPDATE web_private.sessions s
          SET
            id = $2,
            token_hash = $3,
            last_seen_at = $4,
            idle_expires_at = LEAST(
              s.absolute_expires_at,
              $4::timestamptz + ($5::double precision * interval '1 millisecond')
            )
          FROM web_private.users u
          WHERE s.token_hash = $1
            AND u.id = s.user_id
            AND u.status = 'active'
            AND u.session_epoch = s.session_epoch
            AND s.absolute_expires_at > $4
            AND s.idle_expires_at > $4
          RETURNING s.id
        `,
        [
          tokenHash,
          replacementSessionId,
          replacementTokenHash,
          now,
          idleTtlMilliseconds,
        ],
      )

      const row = result.rows[0]
      if (!row) {
        await client.query('DELETE FROM web_private.sessions WHERE token_hash = $1', [
          tokenHash,
        ])
        return undefined
      }

      const session = await loadSession(client, row.id)
      if (!session) {
        await client.query('DELETE FROM web_private.sessions WHERE id = $1', [row.id])
      }
      return session
    })
  }

  async delete(tokenHash: string) {
    await this.pool.query('DELETE FROM web_private.sessions WHERE token_hash = $1', [tokenHash])
  }

  async deleteByUserId(userId: string) {
    const result = await this.pool.query<{ deleted_count: string }>(
      'SELECT web_private.revoke_user_sessions($1::uuid)::text AS deleted_count',
      [userId],
    )
    return parseNonNegativeInteger(result.rows[0]?.deleted_count, 'deleted_count')
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
