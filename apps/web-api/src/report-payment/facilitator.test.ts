import { describe, expect, it, vi } from 'vitest'

import {
  facilitatorPaymentKeyFor,
  HttpReportPaymentFacilitator,
  type X402PaymentPayload,
  type X402PaymentRequirement,
} from './facilitator.js'

const requirement: X402PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:91342',
  asset: '0x1111111111111111111111111111111111111111',
  amount: '100000',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: {
    paymentOrderId: 'order-1',
    pointerVersion: 3,
    resourceDigest: 'a'.repeat(64),
  },
}

const payment: X402PaymentPayload = {
  x402Version: 2,
  accepted: requirement,
  payload: {
    signature: `0x${'1'.repeat(130)}`,
    authorization: {
      from: '0x3333333333333333333333333333333333333333',
      to: requirement.payTo,
      value: requirement.amount,
      validAfter: '0',
      validBefore: '9999999999',
      nonce: `0x${'4'.repeat(64)}`,
    },
  },
}

const input = {
  paymentPayload: payment,
  paymentRequirements: requirement,
}

describe('HttpReportPaymentFacilitator v1', () => {
  it('derives the provider-compatible canonical payment key', () => {
    expect(facilitatorPaymentKeyFor(payment)).toBe(
      '0xb1e98ae92be7bcbae2486aad2c53267dc9e82883763ddb318cb7fc66612c6882',
    )
  })

  it('uses the versioned verify endpoint', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          isValid: true,
          payer: payment.payload.authorization.from,
        }),
        { status: 200 },
      ),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.verify(input)).resolves.toEqual({
      valid: true,
      payer: payment.payload.authorization.from,
    })
    expect(fetcher).toHaveBeenCalledWith(
      'https://facilitator.internal/v1/verify',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('preserves reconciliation-pending settlement as non-terminal', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'pending',
          paymentKey: `0x${'9'.repeat(64)}`,
          retryAfterSeconds: 5,
        }),
        { status: 202 },
      ),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.settle(input)).resolves.toEqual({
      status: 'pending',
      paymentKey: `0x${'9'.repeat(64)}`,
      retryAfterSeconds: 5,
    })
  })

  it('returns terminal provider failure without treating it as transport failure', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'failed',
          paymentKey: `0x${'9'.repeat(64)}`,
          reason: 'payment_binding_mismatch',
        }),
        { status: 422 },
      ),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.settle(input)).resolves.toEqual({
      status: 'failed',
      paymentKey: `0x${'9'.repeat(64)}`,
      reason: 'payment_binding_mismatch',
    })
  })

  it('rejects a malformed success response instead of synthesizing terminal failure', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'settled',
          paymentKey: `0x${'9'.repeat(64)}`,
          transaction: 'not-a-transaction',
          network: 'eip155:91342',
          payer: payment.payload.authorization.from,
        }),
        { status: 200 },
      ),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.settle(input)).rejects.toThrow(
      'Malformed facilitator settlement response',
    )
  })

  it('recovers a durable settlement by provider payment key', async () => {
    const paymentKey = `0x${'9'.repeat(64)}`
    const transaction = `0x${'7'.repeat(64)}`
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: 'settled',
          paymentKey,
          transaction,
        }),
        { status: 200 },
      ),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.recover(paymentKey)).resolves.toEqual({
      status: 'settled',
      paymentKey,
      transaction,
    })
    expect(fetcher).toHaveBeenCalledWith(
      `https://facilitator.internal/v1/settlements/${paymentKey}`,
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('rejects a recovery failure without a valid provider payment key', async () => {
    const paymentKey = `0x${'9'.repeat(64)}`
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'failed' }), { status: 200 }),
    )
    const facilitator = new HttpReportPaymentFacilitator(
      'https://facilitator.internal',
      8_000,
      fetcher,
    )

    await expect(facilitator.recover(paymentKey)).rejects.toThrow(
      'Malformed facilitator recovery response',
    )
  })
})
