import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'

import type { ReportPaymentConfig } from '../config.js'

export type X402PaymentRequirement = {
  scheme: 'exact'
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: Record<string, unknown>
}

export type X402PaymentPayload = {
  x402Version: 2
  accepted: X402PaymentRequirement
  payload: {
    signature: string
    authorization: {
      from: string
      to: string
      value: string
      validAfter: string
      validBefore: string
      nonce: string
    }
  }
}

export type X402Settlement = {
  status: 'settled'
  paymentKey: string
  transaction: string
  network: string
  payer: string
}

export type X402SettlementPending = {
  status: 'pending'
  paymentKey: string
  retryAfterSeconds: number
}

export type X402SettlementFailed = {
  status: 'failed'
  paymentKey: string
  reason: string
}

export type X402SettlementRecovery =
  | {
      status: 'settled'
      paymentKey: string
      transaction: string
    }
  | {
      status: 'pending' | 'failed' | 'missing'
      paymentKey: string
      transaction?: string
    }

const canonicalize = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new TypeError('Payment payload arrays must use Array.prototype')
    }
    const entries: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('Payment payload arrays must be dense data arrays')
      }
      entries.push(canonicalize(descriptor.value))
    }
    const allowedKeys = new Set([
      'length',
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ])
    if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(String(key)))) {
      throw new TypeError('Payment payload arrays cannot have extra properties')
    }
    return `[${entries.join(',')}]`
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Payment payload objects must be plain objects')
    }
    const entries = Reflect.ownKeys(value).map((key) => {
      if (typeof key !== 'string') {
        throw new TypeError('Payment payload objects cannot have symbol keys')
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError(
          'Payment payload objects must contain enumerable data properties',
        )
      }
      return [key, descriptor.value] as const
    })
    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`)
      .join(',')}}`
  }
  throw new TypeError('Payment payload must contain only JSON values')
}

export const facilitatorPaymentKeyFor = (payment: X402PaymentPayload) =>
  `0x${createHash('sha256').update(canonicalize(payment)).digest('hex')}`

const createMtlsFetch = (
  tls: NonNullable<ReportPaymentConfig['tls']>,
): typeof fetch => {
  const credentials = {
    ca: readFileSync(tls.caPath),
    cert: readFileSync(tls.certPath),
    key: readFileSync(tls.keyPath),
  }
  return ((input: string | URL | globalThis.Request, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url =
        input instanceof globalThis.Request
          ? new URL(input.url)
          : new URL(input.toString())
      const request = httpsRequest(
        url,
        {
          method: init?.method,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          ...credentials,
          rejectUnauthorized: true,
          servername: tls.serverName,
        },
        (response) => {
          const chunks: Buffer[] = []
          let responseBytes = 0
          let responseTooLarge = false
          response.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length
            if (responseBytes > 65_536) {
              responseTooLarge = true
              request.destroy(
                new Error('Facilitator response exceeds 65536 bytes'),
              )
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            if (responseTooLarge) return
            const headers = new Headers()
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                for (const entry of value) headers.append(name, entry)
              } else if (value !== undefined) {
                headers.set(name, `${value}`)
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode ?? 500,
                headers,
              }),
            )
          })
        },
      )
      request.on('error', reject)
      init?.signal?.addEventListener(
        'abort',
        () => request.destroy(new DOMException('Request aborted', 'AbortError')),
        { once: true },
      )
      if (typeof init?.body === 'string' || init?.body instanceof Uint8Array) {
        request.write(init.body)
      } else if (init?.body !== undefined && init.body !== null) {
        request.destroy(new TypeError('Unsupported facilitator request body'))
        return
      }
      request.end()
    })) as typeof fetch
}

export const createReportPaymentFacilitator = (
  config: ReportPaymentConfig,
) =>
  new HttpReportPaymentFacilitator(
    config.facilitatorUrl,
    8_000,
    config.tls ? createMtlsFetch(config.tls) : fetch,
  )

export interface ReportPaymentFacilitator {
  verify(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }): Promise<{ valid: true; payer: string } | { valid: false; reason: string }>
  settle(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }): Promise<X402Settlement | X402SettlementPending | X402SettlementFailed>
  recover(paymentKey: string): Promise<X402SettlementRecovery>
}

const readJson = async (response: Response) => {
  const value = (await response.json()) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error('Facilitator returned a non-object response')
  }
  return value as Record<string, unknown>
}

const paymentKeyPattern = /^0x[0-9a-fA-F]{64}$/
const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/
const addressPattern = /^0x[0-9a-fA-F]{40}$/

export class HttpReportPaymentFacilitator implements ReportPaymentFacilitator {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 8_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async post(path: '/v1/verify' | '/v1/settle', body: unknown) {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok && response.status !== 422) {
      throw new Error(`Facilitator ${path} failed with HTTP ${response.status}`)
    }
    return readJson(response)
  }

  async verify(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }) {
    const value = await this.post('/v1/verify', input)
    if (value.isValid === true && typeof value.payer === 'string') {
      return { valid: true as const, payer: value.payer }
    }
    return {
      valid: false as const,
      reason: typeof value.invalidReason === 'string' ? value.invalidReason : 'verification failed',
    }
  }

  async settle(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }) {
    const value = await this.post('/v1/settle', input)
    if (
      value.status === 'settled' &&
      typeof value.paymentKey === 'string' &&
      paymentKeyPattern.test(value.paymentKey) &&
      typeof value.transaction === 'string' &&
      transactionHashPattern.test(value.transaction) &&
      value.network === 'eip155:91342' &&
      typeof value.payer === 'string' &&
      addressPattern.test(value.payer)
    ) {
      return {
        status: 'settled' as const,
        paymentKey: value.paymentKey,
        transaction: value.transaction,
        network: value.network,
        payer: value.payer,
      }
    }
    if (
      value.status === 'pending' &&
      typeof value.paymentKey === 'string' &&
      paymentKeyPattern.test(value.paymentKey) &&
      typeof value.retryAfterSeconds === 'number' &&
      Number.isSafeInteger(value.retryAfterSeconds) &&
      value.retryAfterSeconds > 0
    ) {
      return {
        status: 'pending' as const,
        paymentKey: value.paymentKey,
        retryAfterSeconds: value.retryAfterSeconds,
      }
    }
    if (
      value.status === 'failed' &&
      typeof value.paymentKey === 'string' &&
      paymentKeyPattern.test(value.paymentKey) &&
      typeof value.reason === 'string' &&
      value.reason.length > 0
    ) {
      return {
        status: 'failed' as const,
        paymentKey: value.paymentKey,
        reason: value.reason,
      }
    }
    throw new Error('Malformed facilitator settlement response')
  }

  async recover(paymentKey: string): Promise<X402SettlementRecovery> {
    const response = await this.fetcher(
      `${this.baseUrl}/v1/settlements/${encodeURIComponent(paymentKey)}`,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`Facilitator recovery failed with HTTP ${response.status}`)
    }
    const value = await readJson(response)
    if (
      value.status === 'settled' &&
      typeof value.transaction === 'string' &&
      transactionHashPattern.test(value.transaction) &&
      typeof value.paymentKey === 'string' &&
      paymentKeyPattern.test(value.paymentKey)
    ) {
      return {
        status: 'settled',
        paymentKey: value.paymentKey,
        transaction: value.transaction,
      }
    }
    if (
      (value.status === 'pending' ||
        value.status === 'failed' ||
        value.status === 'missing') &&
      typeof value.paymentKey === 'string' &&
      paymentKeyPattern.test(value.paymentKey) &&
      (value.transaction === undefined ||
        (typeof value.transaction === 'string' &&
          transactionHashPattern.test(value.transaction)))
    ) {
      return {
        status: value.status,
        paymentKey: value.paymentKey,
        ...(typeof value.transaction === 'string'
          ? { transaction: value.transaction }
          : {}),
      }
    }
    throw new Error('Malformed facilitator recovery response')
  }
}
