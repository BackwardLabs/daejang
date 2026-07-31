import { describe, expect, it } from 'vitest'

import type { ReportPaymentFacilitator } from './facilitator.js'
import {
  reconcileReportPayments,
  reportPaymentReconciliationEnabled,
} from './reconciler.js'
import { MemoryReportPaymentStore } from './types.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const PAYER = '0x1111111111111111111111111111111111111111'
const TRANSACTION = `0x${'7'.repeat(64)}`
const PAYMENT_KEY = `0x${'9'.repeat(64)}`

const createReservedOrder = async (store: MemoryReportPaymentStore) => {
  const now = new Date('2028-01-10T00:00:00.000Z')
  const order = await store.getOrCreateQuote(
    {
      userId: USER_ID,
      reportId: 'report-1',
      residentId: 'resident-1',
      taxYear: 2027,
      finality: 'FINAL',
      pointerVersion: 3,
      reportArtifactDigest: 'a'.repeat(64),
      format: 'json',
      resourceDigest: 'b'.repeat(64),
    },
    {
      scheme: 'exact',
      network: 'eip155:91342',
      asset: '0x2222222222222222222222222222222222222222',
      amount: '100000',
      payTo: '0x3333333333333333333333333333333333333333',
      maxTimeoutSeconds: 300,
    },
    new Date(now.getTime() + 300_000),
  )
  await store.reserveSettlement({
    orderId: order.id,
    userId: USER_ID,
    resourceDigest: order.resourceDigest,
    payloadHash: 'c'.repeat(64),
    facilitatorPaymentKey: PAYMENT_KEY,
    payer: PAYER,
    authorizationNonce: `0x${'4'.repeat(64)}`,
    now,
  })
  return { now, order }
}

const facilitatorWith = (
  status: 'settled' | 'pending' | 'failed',
): ReportPaymentFacilitator => ({
  async verify() {
    return { valid: false, reason: 'unused' }
  },
  async settle() {
    return { status: 'failed', paymentKey: PAYMENT_KEY, reason: 'unused' }
  },
  async recover(paymentKey) {
    return status === 'settled'
      ? { status, paymentKey, transaction: TRANSACTION }
      : { status, paymentKey }
  },
})

describe('report payment reconciliation', () => {
  it('exits cleanly when the payment feature is disabled', () => {
    expect(
      reportPaymentReconciliationEnabled({
        X402_REPORT_PAYMENTS_ENABLED: 'false',
      }),
    ).toBe(false)
  })

  it('grants the bound entitlement after recovering a settled provider payment', async () => {
    const store = new MemoryReportPaymentStore()
    const { now, order } = await createReservedOrder(store)

    const result = await reconcileReportPayments({
      store,
      facilitator: facilitatorWith('settled'),
      before: new Date(now.getTime() + 31_000),
      limit: 10,
    })

    expect(result).toEqual({ scanned: 1, settled: 1, failed: 0, pending: 0 })
    expect(store.orders.get(order.id)?.state).toBe('SETTLED')
    await expect(
      store.findEntitlement(USER_ID, order.resourceDigest, 'json'),
    ).resolves.toEqual({ paymentOrderId: order.id })
  })

  it('leaves pending provider work recoverable', async () => {
    const store = new MemoryReportPaymentStore()
    const { now, order } = await createReservedOrder(store)

    const result = await reconcileReportPayments({
      store,
      facilitator: facilitatorWith('pending'),
      before: new Date(now.getTime() + 31_000),
      limit: 10,
    })

    expect(result.pending).toBe(1)
    expect(store.orders.get(order.id)?.state).toBe('SETTLING')
  })

  it('does not grant entitlement for a response bound to another payment key', async () => {
    const store = new MemoryReportPaymentStore()
    const { now, order } = await createReservedOrder(store)
    const facilitator: ReportPaymentFacilitator = {
      ...facilitatorWith('settled'),
      async recover() {
        return {
          status: 'settled',
          paymentKey: `0x${'f'.repeat(64)}`,
          transaction: TRANSACTION,
        }
      },
    }

    const result = await reconcileReportPayments({
      store,
      facilitator,
      before: new Date(now.getTime() + 31_000),
      limit: 10,
    })

    expect(result.pending).toBe(1)
    expect(store.orders.get(order.id)?.state).toBe('SETTLING')
    await expect(
      store.findEntitlement(USER_ID, order.resourceDigest, 'json'),
    ).resolves.toBeUndefined()
  })

  it('marks only provider-confirmed terminal failures as failed', async () => {
    const store = new MemoryReportPaymentStore()
    const { now, order } = await createReservedOrder(store)

    const result = await reconcileReportPayments({
      store,
      facilitator: facilitatorWith('failed'),
      before: new Date(now.getTime() + 31_000),
      limit: 10,
    })

    expect(result.failed).toBe(1)
    expect(store.orders.get(order.id)?.state).toBe('FAILED')
  })

  it('keeps a terminal response for another payment key recoverable', async () => {
    const store = new MemoryReportPaymentStore()
    const { now, order } = await createReservedOrder(store)
    const facilitator: ReportPaymentFacilitator = {
      ...facilitatorWith('failed'),
      async recover() {
        return {
          status: 'failed',
          paymentKey: `0x${'f'.repeat(64)}`,
        }
      },
    }

    const result = await reconcileReportPayments({
      store,
      facilitator,
      before: new Date(now.getTime() + 31_000),
      limit: 10,
    })

    expect(result).toEqual({ scanned: 1, settled: 0, failed: 0, pending: 1 })
    expect(store.orders.get(order.id)?.state).toBe('SETTLING')
  })
})
