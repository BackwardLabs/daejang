import type { Pool, PoolClient } from 'pg'

import type {
  CompleteWalletRegistration,
  WalletChainScope,
  WalletOwnershipChallenge,
  WalletSource,
  WalletSourceStore,
  WalletSourceStatus,
} from './wallet-source-store.js'

type WalletSourceRow = {
  id: string
  address: string
  account_type: 'EOA'
  verification_chain_id: string
  verified_at: Date
  label: string | null
  status: WalletSourceStatus
  created_at: Date
  updated_at: Date
  disconnected_at: Date | null
  chain_id: string | null
  chain_status: WalletChainScope['status'] | null
}

type WalletChallengeRow = {
  id: string
  user_id: string
  address: string
  verification_chain_id: string
  message: string
  issued_at: Date
  expires_at: Date
  consumed_at: Date | null
}

const toChallenge = (row: WalletChallengeRow): WalletOwnershipChallenge => ({
  id: row.id,
  userId: row.user_id,
  address: row.address,
  verificationChainId: row.verification_chain_id,
  message: row.message,
  issuedAt: row.issued_at,
  expiresAt: row.expires_at,
  consumedAt: row.consumed_at ?? undefined,
})

const toWalletSources = (rows: WalletSourceRow[]) => {
  const sources = new Map<string, WalletSource>()
  for (const row of rows) {
    let source = sources.get(row.id)
    if (!source) {
      source = {
        id: row.id,
        address: row.address,
        accountType: row.account_type,
        verificationChainId: row.verification_chain_id,
        verifiedAt: row.verified_at,
        label: row.label ?? undefined,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        disconnectedAt: row.disconnected_at ?? undefined,
        chainScopes: [],
      }
      sources.set(row.id, source)
    }
    if (row.chain_id && row.chain_status) {
      source.chainScopes.push({ chainId: row.chain_id, status: row.chain_status })
    }
  }
  return [...sources.values()]
}

const walletSourceSelect = `
  SELECT
    ws.id,
    ws.address,
    ws.account_type,
    ws.verification_chain_id,
    ws.verified_at,
    ws.label,
    ws.status,
    ws.created_at,
    ws.updated_at,
    ws.disconnected_at,
    scope.chain_id,
    scope.status AS chain_status
  FROM source_private.wallet_sources ws
  LEFT JOIN source_private.wallet_chain_scopes scope
    ON scope.wallet_source_id = ws.id
`

export class PostgresWalletSourceStore implements WalletSourceStore {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async createChallenge(challenge: WalletOwnershipChallenge) {
    await this.pool.query(
      `
        INSERT INTO source_private.wallet_ownership_challenges (
          id,
          user_id,
          address,
          verification_chain_id,
          message,
          issued_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        challenge.id,
        challenge.userId,
        challenge.address,
        challenge.verificationChainId,
        challenge.message,
        challenge.issuedAt,
        challenge.expiresAt,
      ],
    )
  }

  async getChallenge(userId: string, challengeId: string) {
    const result = await this.pool.query<WalletChallengeRow>(
      `
        SELECT
          id,
          user_id,
          address,
          verification_chain_id,
          message,
          issued_at,
          expires_at,
          consumed_at
        FROM source_private.wallet_ownership_challenges
        WHERE id = $1 AND user_id = $2
      `,
      [challengeId, userId],
    )
    const row = result.rows[0]
    return row ? toChallenge(row) : undefined
  }

  async completeRegistration(input: CompleteWalletRegistration) {
    return this.#transaction(async (client) => {
      const challenge = await client.query<WalletChallengeRow>(
        `
          SELECT
            id,
            user_id,
            address,
            verification_chain_id,
            message,
            issued_at,
            expires_at,
            consumed_at
          FROM source_private.wallet_ownership_challenges
          WHERE id = $1 AND user_id = $2
          FOR UPDATE
        `,
        [input.challengeId, input.userId],
      )
      const challengeRow = challenge.rows[0]
      if (
        !challengeRow ||
        challengeRow.consumed_at ||
        challengeRow.expires_at.getTime() <= input.now.getTime() ||
        challengeRow.address !== input.recoveredAddress
      ) {
        return undefined
      }

      await client.query(
        `
          UPDATE source_private.wallet_ownership_challenges
          SET consumed_at = $3
          WHERE id = $1 AND user_id = $2 AND consumed_at IS NULL
        `,
        [input.challengeId, input.userId, input.now],
      )

      const sourceId = crypto.randomUUID()
      const stored = await client.query<{ id: string }>(
        `
          INSERT INTO source_private.wallet_sources (
            id,
            user_id,
            address,
            account_type,
            verification_chain_id,
            verified_at,
            label
          ) VALUES ($1, $2, $3, 'EOA', $4, $5, $6)
          ON CONFLICT (user_id, address) DO UPDATE
          SET
            verification_chain_id = EXCLUDED.verification_chain_id,
            verified_at = EXCLUDED.verified_at,
            label = COALESCE(EXCLUDED.label, source_private.wallet_sources.label),
            status = 'ACTIVE',
            disconnected_at = NULL
          RETURNING id
        `,
        [
          sourceId,
          input.userId,
          challengeRow.address,
          challengeRow.verification_chain_id,
          input.now,
          input.label,
        ],
      )
      const walletSourceId = stored.rows[0]?.id
      if (!walletSourceId) {
        throw new Error('PostgreSQL did not return the wallet source id')
      }

      await client.query(
        `
          UPDATE source_private.wallet_chain_scopes
          SET status = 'DISABLED', disabled_at = $2
          WHERE wallet_source_id = $1
            AND status = 'ACTIVE'
            AND NOT (chain_id = ANY($3::text[]))
        `,
        [walletSourceId, input.now, input.chainIds],
      )
      for (const chainId of input.chainIds) {
        await client.query(
          `
            INSERT INTO source_private.wallet_chain_scopes (
              wallet_source_id,
              chain_id
            ) VALUES ($1, $2)
            ON CONFLICT (wallet_source_id, chain_id) DO UPDATE
            SET status = 'ACTIVE', disabled_at = NULL
          `,
          [walletSourceId, chainId],
        )
      }

      return this.#loadWallet(client, input.userId, walletSourceId)
    })
  }

  async listWallets(userId: string) {
    const result = await this.pool.query<WalletSourceRow>(
      `${walletSourceSelect}
       WHERE ws.user_id = $1
       ORDER BY ws.created_at DESC, scope.chain_id ASC`,
      [userId],
    )
    return toWalletSources(result.rows)
  }

  async disconnectWallet(userId: string, sourceId: string, now: Date) {
    return this.#transaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `
          UPDATE source_private.wallet_sources
          SET status = 'DISCONNECTED', disconnected_at = $3
          WHERE id = $1 AND user_id = $2
          RETURNING id
        `,
        [sourceId, userId, now],
      )
      if (!result.rows[0]) {
        return undefined
      }

      await client.query(
        `
          UPDATE source_private.wallet_chain_scopes
          SET status = 'DISABLED', disabled_at = $2
          WHERE wallet_source_id = $1 AND status = 'ACTIVE'
        `,
        [sourceId, now],
      )
      return this.#loadWallet(client, userId, sourceId)
    })
  }

  async #loadWallet(client: PoolClient, userId: string, sourceId: string) {
    const result = await client.query<WalletSourceRow>(
      `${walletSourceSelect}
       WHERE ws.user_id = $1 AND ws.id = $2
       ORDER BY scope.chain_id ASC`,
      [userId, sourceId],
    )
    return toWalletSources(result.rows)[0]
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
