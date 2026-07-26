import type { Pool, PoolClient } from 'pg'

import type {
  SessionRecord,
  SessionStore,
  WorkspaceMembership,
  WorkspaceRole,
} from './session.js'

type SessionTransition = Parameters<SessionStore['resolveAndTouch']>[0]
type RotateSessionTransition = Parameters<SessionStore['rotate']>[0]

type SessionRow = {
  id: string
  user_id: string
  display_name: string
  membership_version: string
  session_epoch: string
  active_workspace_id: string
  memberships: WorkspaceMembership[]
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

const toSessionRecord = (row: SessionRow): SessionRecord => ({
  id: row.id,
  user: { id: row.user_id, displayName: row.display_name },
  memberships: row.memberships,
  membershipVersion: parsePositiveInteger(
    row.membership_version,
    'membership_version',
  ),
  sessionEpoch: parsePositiveInteger(row.session_epoch, 'session_epoch'),
  activeWorkspaceId: row.active_workspace_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  absoluteExpiresAt: row.absolute_expires_at,
  idleExpiresAt: row.idle_expires_at,
})

const loadSession = async (client: PoolClient, sessionId: string) => {
  const result = await client.query<SessionRow>(
    `
      SELECT
        s.id,
        s.user_id,
        u.display_name,
        s.membership_version,
        s.session_epoch,
        s.active_workspace_id,
        membership_list.memberships,
        s.created_at,
        s.last_seen_at,
        s.absolute_expires_at,
        s.idle_expires_at
      FROM web_private.sessions s
      JOIN web_private.users u
        ON u.id = s.user_id
        AND u.membership_version = s.membership_version
        AND u.session_epoch = s.session_epoch
      CROSS JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'workspaceId', workspace.id,
            'workspaceName', workspace.name,
            'role', membership.role
          ) ORDER BY workspace.id
        ) AS memberships
        FROM web_private.workspace_memberships membership
        JOIN web_private.workspaces workspace ON workspace.id = membership.workspace_id
        WHERE membership.user_id = s.user_id
      ) membership_list
      WHERE s.id = $1
        AND membership_list.memberships IS NOT NULL
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
            AND u.membership_version = s.membership_version
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
        const revoked = await client.query<{ id: string }>(
          'DELETE FROM web_private.sessions WHERE token_hash = $1 RETURNING id',
          [currentTokenHash],
        )
        if (revoked.rowCount !== 1) {
          return undefined
        }
      }

      return this.#insertSession(client, replacementTokenHash, replacement)
    })
  }

  async #insertSession(client: PoolClient, tokenHash: string, session: SessionRecord) {
    const user = await client.query<{
      membership_version: string
      session_epoch: string
    }>(
      `
        SELECT u.membership_version, u.session_epoch
        FROM web_private.users u
        JOIN web_private.workspace_memberships membership
          ON membership.user_id = u.id
          AND membership.workspace_id = $2
        WHERE u.id = $1
        FOR UPDATE OF u
      `,
      [session.user.id, session.activeWorkspaceId],
    )
    const userRow = user.rows[0]
    if (!userRow) {
      throw new Error('Session user or active workspace membership does not exist')
    }

    await client.query(
      `
        INSERT INTO web_private.sessions (
          id,
          token_hash,
          user_id,
          membership_version,
          session_epoch,
          active_workspace_id,
          created_at,
          last_seen_at,
          absolute_expires_at,
          idle_expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        session.id,
        tokenHash,
        session.user.id,
        userRow.membership_version,
        userRow.session_epoch,
        session.activeWorkspaceId,
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
            AND u.membership_version = s.membership_version
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
    await this.pool.query('DELETE FROM web_private.sessions WHERE token_hash = $1', [
      tokenHash,
    ])
  }

  async deleteByUserId(userId: string) {
    return this.#transaction(async (client) => {
      const updated = await client.query(
        `
          UPDATE web_private.users
          SET session_epoch = session_epoch + 1, updated_at = clock_timestamp()
          WHERE id = $1
          RETURNING id
        `,
        [userId],
      )
      if (updated.rowCount !== 1) {
        return 0
      }

      const deleted = await client.query(
        'DELETE FROM web_private.sessions WHERE user_id = $1',
        [userId],
      )
      return deleted.rowCount ?? 0
    })
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

export class PostgresMembershipStore {
  constructor(private readonly pool: Pool) {}

  async upsertUser(user: { id: string; displayName: string }) {
    await this.pool.query(
      `
        INSERT INTO web_private.users (id, display_name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE
        SET display_name = EXCLUDED.display_name, updated_at = clock_timestamp()
      `,
      [user.id, user.displayName],
    )
  }

  async upsertWorkspace(workspace: { id: string; name: string }) {
    await this.pool.query(
      `
        INSERT INTO web_private.workspaces (id, name)
        VALUES ($1, $2)
        ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name, updated_at = clock_timestamp()
      `,
      [workspace.id, workspace.name],
    )
  }

  async setMembership(input: {
    userId: string
    workspaceId: string
    role: WorkspaceRole
  }) {
    await this.pool.query(
      `
        INSERT INTO web_private.workspace_memberships (user_id, workspace_id, role)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, workspace_id) DO UPDATE
        SET role = EXCLUDED.role, updated_at = clock_timestamp()
      `,
      [input.userId, input.workspaceId, input.role],
    )
  }

  async removeMembership(userId: string, workspaceId: string) {
    await this.pool.query(
      `
        DELETE FROM web_private.workspace_memberships
        WHERE user_id = $1 AND workspace_id = $2
      `,
      [userId, workspaceId],
    )
  }
}
