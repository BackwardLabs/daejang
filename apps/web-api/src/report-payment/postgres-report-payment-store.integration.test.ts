import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresReportPaymentStore } from './postgres-report-payment-store.js'

const runtimeDatabaseUrl = process.env.REPORT_PAYMENT_TEST_DATABASE_URL
const adminDatabaseUrl = process.env.REPORT_PAYMENT_TEST_ADMIN_DATABASE_URL
const describeWithPostgres =
  runtimeDatabaseUrl && adminDatabaseUrl ? describe : describe.skip

const ORDER_ID = '00000000-0000-4000-8000-000000000491'
const USER_ID = '00000000-0000-4000-8000-000000000492'
const RESOURCE_DIGEST = 'a'.repeat(64)
const PAYLOAD_HASH = 'b'.repeat(64)
const PAYMENT_KEY = `0x${'c'.repeat(64)}`
const NONCE = `0x${'d'.repeat(64)}`
const PAYER = `0x${'e'.repeat(40)}`

describeWithPostgres('PostgreSQL report payment settlement recovery', () => {
  const admin = new Pool({ connectionString: adminDatabaseUrl })
  const runtime = new Pool({ connectionString: runtimeDatabaseUrl })
  const store = new PostgresReportPaymentStore(runtime)

  beforeAll(async () => {
    await runtime.query('SELECT 1')
  })

  beforeEach(async () => {
    await admin.query(
      'DELETE FROM web_private.report_payment_authorizations WHERE payment_order_id=$1',
      [ORDER_ID],
    )
    await admin.query(
      'DELETE FROM web_private.report_payment_entitlements WHERE payment_order_id=$1',
      [ORDER_ID],
    )
    await admin.query(
      'DELETE FROM web_private.report_payment_orders WHERE id=$1',
      [ORDER_ID],
    )

    const client = await admin.connect()
    try {
      await client.query("SET session_replication_role = 'replica'")
      await client.query(
        `
          INSERT INTO web_private.report_payment_orders (
            id, user_id, report_id, resident_id, tax_year, finality,
            pointer_version, report_artifact_digest, format, resource_digest,
            scheme, network, asset_address, amount_atomic, pay_to_address,
            max_timeout_seconds, state, expires_at
          ) VALUES (
            $1, $2, 'report-recovery-test', 'resident-recovery-test', 2027,
            'FINAL', 1, $3, 'json', $4, 'exact', 'eip155:91342',
            $5, 100000, $6, 300, 'QUOTED', $7
          )
        `,
        [
          ORDER_ID,
          USER_ID,
          'f'.repeat(64),
          RESOURCE_DIGEST,
          `0x${'1'.repeat(40)}`,
          `0x${'2'.repeat(40)}`,
          new Date(Date.now() + 300_000),
        ],
      )
    } finally {
      await client.query("SET session_replication_role = 'origin'")
      client.release()
    }
  })

  afterAll(async () => {
    await admin.query(
      'DELETE FROM web_private.report_payment_authorizations WHERE payment_order_id=$1',
      [ORDER_ID],
    )
    await admin.query(
      'DELETE FROM web_private.report_payment_entitlements WHERE payment_order_id=$1',
      [ORDER_ID],
    )
    await admin.query(
      'DELETE FROM web_private.report_payment_orders WHERE id=$1',
      [ORDER_ID],
    )
    await runtime.end()
    await admin.end()
  })

  it('persists the provider key and lets only one worker claim stale settlement work', async () => {
    const reserved = await store.reserveSettlement({
      orderId: ORDER_ID,
      userId: USER_ID,
      resourceDigest: RESOURCE_DIGEST,
      payloadHash: PAYLOAD_HASH,
      facilitatorPaymentKey: PAYMENT_KEY,
      payer: PAYER,
      authorizationNonce: NONCE,
      now: new Date(),
    })

    expect(reserved).toMatchObject({
      kind: 'reserved',
      order: {
        id: ORDER_ID,
        state: 'SETTLING',
        facilitatorPaymentKey: PAYMENT_KEY,
      },
    })
    const persisted = await admin.query<{
      facilitator_payment_key: string
    }>(
      'SELECT facilitator_payment_key FROM web_private.report_payment_orders WHERE id=$1',
      [ORDER_ID],
    )
    expect(persisted.rows[0]?.facilitator_payment_key).toBe(PAYMENT_KEY)

    await admin.query(
      "UPDATE web_private.report_payment_orders SET updated_at='2000-01-01T00:00:00Z' WHERE id=$1",
      [ORDER_ID],
    )
    const before = new Date()
    const [left, right] = await Promise.all([
      store.claimRecoverableSettlements(before, 1),
      store.claimRecoverableSettlements(before, 1),
    ])

    expect([...left, ...right]).toHaveLength(1)
    expect([...left, ...right][0]).toMatchObject({
      id: ORDER_ID,
      facilitatorPaymentKey: PAYMENT_KEY,
    })
  })
})
