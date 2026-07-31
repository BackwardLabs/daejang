import { setTimeout as delay } from 'node:timers/promises'

import { Pool } from 'pg'

import { loadReportPaymentConfig } from './config.js'
import { assertReportPaymentSchema } from './database/preflight.js'
import { createReportPaymentFacilitator } from './report-payment/facilitator.js'
import { PostgresReportPaymentStore } from './report-payment/postgres-report-payment-store.js'
import {
  reconcileReportPayments,
  reportPaymentReconciliationEnabled,
} from './report-payment/reconciler.js'

const positiveInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
) => {
  if (value === undefined) return fallback
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  return Number(value)
}

if (!reportPaymentReconciliationEnabled(process.env)) {
  console.info(JSON.stringify({ event: 'x402_reconciliation_disabled' }))
} else {
  const databaseUrl = process.env.DATABASE_URL
  const reportPayments = loadReportPaymentConfig(process.env, true)
  if (!databaseUrl || !reportPayments) {
    throw new Error(
      'DATABASE_URL and enabled x402 report payments are required for reconciliation',
    )
  }

  const intervalSeconds = positiveInteger(
    process.env.X402_RECONCILE_INTERVAL_SECONDS,
    30,
    'X402_RECONCILE_INTERVAL_SECONDS',
  )
  const staleSeconds = positiveInteger(
    process.env.X402_RECONCILE_STALE_SECONDS,
    60,
    'X402_RECONCILE_STALE_SECONDS',
  )
  const limit = positiveInteger(
    process.env.X402_RECONCILE_LIMIT,
    100,
    'X402_RECONCILE_LIMIT',
  )
  const pool = new Pool({
    connectionString: databaseUrl,
    application_name: 'daejang-report-payment-reconciler',
    max: 2,
    statement_timeout: 10_000,
  })
  await assertReportPaymentSchema(pool)

  const store = new PostgresReportPaymentStore(pool)
  const facilitator = createReportPaymentFacilitator(reportPayments)
  const controller = new AbortController()
  process.once('SIGINT', () => controller.abort())
  process.once('SIGTERM', () => controller.abort())

  try {
    while (!controller.signal.aborted) {
      const result = await reconcileReportPayments({
        store,
        facilitator,
        before: new Date(Date.now() - staleSeconds * 1_000),
        limit,
      })
      if (result.scanned > 0) {
        console.info(JSON.stringify({ event: 'x402_reconciliation', ...result }))
      }
      await delay(intervalSeconds * 1_000, undefined, {
        signal: controller.signal,
      }).catch(() => undefined)
    }
  } finally {
    await pool.end()
  }
}
