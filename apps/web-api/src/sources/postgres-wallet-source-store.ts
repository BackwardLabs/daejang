import type { Pool } from 'pg'

import type {
  CompleteWalletRegistration,
  SourceRequestContext,
  WalletOwnershipChallenge,
  WalletSourceRegistry,
  WalletSourceStore,
} from './wallet-source-store.js'

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

export class PostgresWalletSourceStore implements WalletSourceStore {
  readonly durable: boolean

  constructor(
    private readonly pool: Pool,
    private readonly registry: WalletSourceRegistry,
  ) {
    this.durable = registry.durable
  }

  async createChallenge(challenge: WalletOwnershipChallenge) {
    await this.pool.query(
      `
        INSERT INTO web_private.wallet_ownership_challenges (
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
        FROM web_private.wallet_ownership_challenges
        WHERE id = $1 AND user_id = $2
      `,
      [challengeId, userId],
    )
    const row = result.rows[0]
    return row ? toChallenge(row) : undefined
  }

  async completeRegistration(input: CompleteWalletRegistration) {
    const challenge = await this.getChallenge(input.userId, input.challengeId)
    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= input.now.getTime() ||
      challenge.address !== input.recoveredAddress ||
      challenge.verificationChainId !== input.verificationChainId
    ) {
      return undefined
    }

    const source = await this.registry.registerWallet(input)
    const consumed = await this.pool.query(
      `
        UPDATE web_private.wallet_ownership_challenges
        SET consumed_at = $3
        WHERE id = $1
          AND user_id = $2
          AND consumed_at IS NULL
          AND expires_at > $3
      `,
      [input.challengeId, input.userId, input.now],
    )
    return consumed.rowCount === 1 ? source : undefined
  }

  listWallets(context: SourceRequestContext) {
    return this.registry.listWallets(context)
  }

  disconnectWallet(
    context: SourceRequestContext,
    sourceId: string,
    now: Date,
  ) {
    return this.registry.disconnectWallet(context, sourceId, now)
  }
}
