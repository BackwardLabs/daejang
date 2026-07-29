import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'

import type {
  ReportPaymentBinding,
  ReportPaymentOrder,
  ReportPaymentStore,
  ReportPaymentTerms,
  SettlementReservation,
} from './types.js'

type OrderRow = {
  id: string
  user_id: string
  report_id: string
  resident_id: string
  tax_year: number
  finality: 'FINAL'
  pointer_version: string
  report_artifact_digest: string
  format: 'json'
  resource_digest: string
  scheme: 'exact'
  network: string
  asset_address: string
  amount_atomic: string
  pay_to_address: string
  max_timeout_seconds: number
  state: ReportPaymentOrder['state']
  expires_at: Date
  payer_address: string | null
  payload_hash: string | null
  authorization_nonce: string | null
  transaction_hash: string | null
  updated_at: Date
}

const toOrder = (row: OrderRow): ReportPaymentOrder => ({
  id: row.id,
  userId: row.user_id,
  reportId: row.report_id,
  residentId: row.resident_id,
  taxYear: row.tax_year,
  finality: row.finality,
  pointerVersion: Number(row.pointer_version),
  reportArtifactDigest: row.report_artifact_digest,
  format: row.format,
  resourceDigest: row.resource_digest,
  scheme: row.scheme,
  network: row.network,
  asset: row.asset_address,
  amount: row.amount_atomic,
  payTo: row.pay_to_address,
  maxTimeoutSeconds: row.max_timeout_seconds,
  state: row.state,
  expiresAt: row.expires_at,
  ...(row.payer_address ? { payer: row.payer_address } : {}),
  ...(row.payload_hash ? { payloadHash: row.payload_hash } : {}),
  ...(row.authorization_nonce ? { authorizationNonce: row.authorization_nonce } : {}),
  ...(row.transaction_hash ? { transactionHash: row.transaction_hash } : {}),
})

const selectOrder = `
  SELECT id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
    report_artifact_digest, format, resource_digest, scheme, network, asset_address,
    amount_atomic::text, pay_to_address, max_timeout_seconds, state, expires_at,
    payer_address, payload_hash, authorization_nonce, transaction_hash, updated_at
  FROM web_private.report_payment_orders
`

export class PostgresReportPaymentStore implements ReportPaymentStore {
  readonly durable = true

  constructor(private readonly pool: Pool) {}

  async findEntitlement(userId: string, resourceDigest: string, format: 'json') {
    const result = await this.pool.query(
      `SELECT 1 FROM web_private.report_payment_entitlements WHERE user_id=$1 AND resource_digest=$2 AND format=$3`,
      [userId, resourceDigest, format],
    )
    return result.rowCount === 1
  }

  async getOrCreateQuote(binding: ReportPaymentBinding, terms: ReportPaymentTerms, expiresAt: Date) {
    return this.transaction(async (client) => {
      const inserted = await client.query<OrderRow>(
        `
          INSERT INTO web_private.report_payment_orders (
            id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
            report_artifact_digest, format, resource_digest, scheme, network,
            asset_address, amount_atomic, pay_to_address, max_timeout_seconds, state, expires_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, 'QUOTED', $17
          )
          ON CONFLICT (user_id, resource_digest, format) DO UPDATE SET
            expires_at = EXCLUDED.expires_at,
            updated_at = clock_timestamp(),
            state = 'QUOTED',
            payer_address = NULL,
            payload_hash = NULL,
            authorization_nonce = NULL,
            transaction_hash = NULL,
            settled_at = NULL,
            delivered_at = NULL
          WHERE report_payment_orders.state IN ('QUOTED', 'FAILED')
          RETURNING id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
            report_artifact_digest, format, resource_digest, scheme, network, asset_address,
            amount_atomic::text, pay_to_address, max_timeout_seconds, state, expires_at,
            payer_address, payload_hash, authorization_nonce, transaction_hash, updated_at
        `,
        [
          randomUUID(), binding.userId, binding.reportId, binding.residentId, binding.taxYear,
          binding.finality, binding.pointerVersion, binding.reportArtifactDigest,
          binding.format, binding.resourceDigest, terms.scheme, terms.network,
          terms.asset, terms.amount, terms.payTo, terms.maxTimeoutSeconds, expiresAt,
        ],
      )
      const row = inserted.rows[0]
      if (row) return toOrder(row)

      const existing = await client.query<OrderRow>(
        `${selectOrder} WHERE user_id=$1 AND resource_digest=$2 AND format=$3 FOR UPDATE`,
        [binding.userId, binding.resourceDigest, binding.format],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) throw new Error('Payment order upsert did not return an order')
      return toOrder(existingRow)
    })
  }

  async reserveSettlement(input: {
    orderId: string
    userId: string
    resourceDigest: string
    payloadHash: string
    payer: string
    authorizationNonce: string
    now: Date
  }): Promise<SettlementReservation> {
    return this.transaction(async (client) => {
      const result = await client.query<OrderRow>(
        `${selectOrder} WHERE id=$1 AND user_id=$2 AND resource_digest=$3 FOR UPDATE`,
        [input.orderId, input.userId, input.resourceDigest],
      )
      const row = result.rows[0]
      if (!row || row.expires_at <= input.now || row.state === 'FAILED') return { kind: 'invalid' }
      const order = toOrder(row)
      if (row.state === 'SETTLED' || row.state === 'DELIVERED') {
        return row.payload_hash === input.payloadHash ? { kind: 'settled', order } : { kind: 'invalid' }
      }
      if (row.state === 'SETTLING') {
        if (row.payload_hash !== input.payloadHash) return { kind: 'invalid' }
        if (row.updated_at.getTime() + 30_000 > input.now.getTime()) return { kind: 'busy' }
        const reclaimed = await client.query<OrderRow>(
          `
            UPDATE web_private.report_payment_orders SET updated_at=$2
            WHERE id=$1 AND state='SETTLING'
            RETURNING id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
              report_artifact_digest, format, resource_digest, scheme, network, asset_address,
              amount_atomic::text, pay_to_address, max_timeout_seconds, state, expires_at,
              payer_address, payload_hash, authorization_nonce, transaction_hash, updated_at
          `,
          [row.id, input.now],
        )
        return { kind: 'reserved', order: toOrder(reclaimed.rows[0] as OrderRow) }
      }

      const authorization = await client.query(
        `
          INSERT INTO web_private.report_payment_authorizations(
            network, authorization_nonce, payment_order_id, payload_hash
          ) VALUES ($1,$2,$3,$4)
          ON CONFLICT DO NOTHING
          RETURNING payment_order_id
        `,
        [row.network, input.authorizationNonce, row.id, input.payloadHash],
      )
      if (!authorization.rowCount) return { kind: 'invalid' }

      const updated = await client.query<OrderRow>(
        `
          UPDATE web_private.report_payment_orders SET
            state='SETTLING', payer_address=$2, payload_hash=$3,
            authorization_nonce=$4, updated_at=$5
          WHERE id=$1
          RETURNING id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
            report_artifact_digest, format, resource_digest, scheme, network, asset_address,
            amount_atomic::text, pay_to_address, max_timeout_seconds, state, expires_at,
            payer_address, payload_hash, authorization_nonce, transaction_hash, updated_at
        `,
        [row.id, input.payer, input.payloadHash, input.authorizationNonce, input.now],
      )
      return { kind: 'reserved', order: toOrder(updated.rows[0] as OrderRow) }
    })
  }

  async completeSettlement(input: {
    orderId: string
    userId: string
    resourceDigest: string
    payer: string
    transactionHash: string
  }) {
    return this.transaction(async (client) => {
      const result = await client.query<OrderRow>(
        `
          UPDATE web_private.report_payment_orders SET
            state='SETTLED', transaction_hash=$5, settled_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE id=$1 AND user_id=$2 AND resource_digest=$3 AND state='SETTLING'
            AND lower(payer_address)=lower($4)
          RETURNING id, user_id, report_id, resident_id, tax_year, finality, pointer_version,
            report_artifact_digest, format, resource_digest, scheme, network, asset_address,
            amount_atomic::text, pay_to_address, max_timeout_seconds, state, expires_at,
            payer_address, payload_hash, authorization_nonce, transaction_hash, updated_at
        `,
        [input.orderId, input.userId, input.resourceDigest, input.payer, input.transactionHash],
      )
      const row = result.rows[0]
      if (!row) throw new Error('Settlement does not match the reserved payment order')
      await client.query(
        `INSERT INTO web_private.report_payment_entitlements(user_id, resource_digest, format, payment_order_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [row.user_id, row.resource_digest, row.format, row.id],
      )
      return toOrder(row)
    })
  }

  async failSettlement(orderId: string, userId: string) {
    await this.pool.query(
      `UPDATE web_private.report_payment_orders SET state='FAILED', updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND state='SETTLING'`,
      [orderId, userId],
    )
  }

  async markDelivered(orderId: string, userId: string) {
    await this.pool.query(
      `UPDATE web_private.report_payment_orders SET state='DELIVERED', delivered_at=clock_timestamp(), updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND state='SETTLED'`,
      [orderId, userId],
    )
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const value = await work(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
