import type { ReportPaymentFacilitator } from './facilitator.js'
import type { ReportPaymentStore } from './types.js'

const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/

export const reportPaymentReconciliationEnabled = (
  environment: NodeJS.ProcessEnv,
) => environment.X402_REPORT_PAYMENTS_ENABLED === 'true'

export const reconcileReportPayments = async (options: {
  store: ReportPaymentStore
  facilitator: ReportPaymentFacilitator
  before: Date
  limit: number
}) => {
  const orders = await options.store.claimRecoverableSettlements(
    options.before,
    options.limit,
  )
  const result = {
    scanned: orders.length,
    settled: 0,
    failed: 0,
    pending: 0,
  }
  for (const order of orders) {
    if (!order.facilitatorPaymentKey || !order.payer) {
      result.pending += 1
      continue
    }
    try {
      const recovered = await options.facilitator.recover(
        order.facilitatorPaymentKey,
      )
      if (
        recovered.paymentKey.toLowerCase() !==
        order.facilitatorPaymentKey.toLowerCase()
      ) {
        result.pending += 1
        continue
      }
      if (
        recovered.status === 'settled' &&
        transactionHashPattern.test(recovered.transaction)
      ) {
        await options.store.completeSettlement({
          orderId: order.id,
          userId: order.userId,
          resourceDigest: order.resourceDigest,
          payer: order.payer,
          transactionHash: recovered.transaction,
        })
        result.settled += 1
      } else if (recovered.status === 'failed') {
        await options.store.failSettlement(order.id, order.userId)
        result.failed += 1
      } else {
        result.pending += 1
      }
    } catch {
      result.pending += 1
    }
  }
  return result
}
