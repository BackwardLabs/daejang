import { afterEach, describe, expect, it, vi } from 'vitest'

import { requestSettlementWithRetry } from './reportPaymentApi.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('report payment settlement retry', () => {
  it('retries a pending settlement with the exact same payment signature', async () => {
    const responses = [
      new Response(null, { status: 409, headers: { 'retry-after': '1' } }),
      new Response(null, { status: 409, headers: { 'retry-after': '2' } }),
      new Response(JSON.stringify({ report: {} }), { status: 200 }),
    ]
    const fetchMock = vi.fn<typeof fetch>(
      async () => responses.shift() as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const waits: number[] = []

    const response = await requestSettlementWithRetry(
      '/tax-reports/2027/current/download?finality=FINAL&format=json',
      'stable-payment-signature',
      {
        wait: async (milliseconds) => {
          waits.push(milliseconds)
        },
        maxAttempts: 3,
        maxWaitMilliseconds: 3_000,
      },
    )

    expect(response.status).toBe(200)
    expect(waits).toEqual([1_000, 2_000])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => {
          const headers = init?.headers as Record<string, string> | undefined
          return headers?.['payment-signature']
        },
      ),
    ).toEqual([
      'stable-payment-signature',
      'stable-payment-signature',
      'stable-payment-signature',
    ])
  })

  it('does not retry an unrelated conflict or malformed Retry-After value', async () => {
    const responses = [
      new Response(null, { status: 409 }),
      new Response(null, {
        status: 409,
        headers: { 'retry-after': 'not-a-number' },
      }),
    ]
    const fetchMock = vi.fn<typeof fetch>(
      async () => responses.shift() as Response,
    )
    vi.stubGlobal('fetch', fetchMock)
    const wait = vi.fn(async () => undefined)

    await expect(
      requestSettlementWithRetry('/report', 'signature', { wait }),
    ).resolves.toMatchObject({ status: 409 })
    await expect(
      requestSettlementWithRetry('/report', 'signature', { wait }),
    ).resolves.toMatchObject({ status: 409 })

    expect(wait).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stops before a retry would exceed the settlement wait budget', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 409,
        headers: { 'retry-after': '61' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const wait = vi.fn(async () => undefined)

    const response = await requestSettlementWithRetry('/report', 'signature', {
      wait,
      maxWaitMilliseconds: 60_000,
    })

    expect(response.status).toBe(409)
    expect(wait).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('counts slow HTTP requests against the wall-clock retry budget', async () => {
    let elapsed = 0
    const fetchMock = vi.fn<typeof fetch>(async () => {
      elapsed = 119_500
      return new Response(null, {
        status: 409,
        headers: { 'retry-after': '1' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const wait = vi.fn(async () => undefined)

    const response = await requestSettlementWithRetry('/report', 'signature', {
      wait,
      maxWaitMilliseconds: 120_000,
      now: () => elapsed,
    })

    expect(response.status).toBe(409)
    expect(wait).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
