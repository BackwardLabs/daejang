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
  success: true
  transaction: string
  network: string
  payer: string
}

export interface ReportPaymentFacilitator {
  verify(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }): Promise<{ valid: true; payer: string } | { valid: false; reason: string }>
  settle(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }): Promise<X402Settlement | { success: false; reason: string }>
}

const readJson = async (response: Response) => {
  const value = (await response.json()) as unknown
  if (typeof value !== 'object' || value === null) {
    throw new Error('Facilitator returned a non-object response')
  }
  return value as Record<string, unknown>
}

export class HttpReportPaymentFacilitator implements ReportPaymentFacilitator {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 8_000,
  ) {}

  private async post(path: '/verify' | '/settle', body: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!response.ok) {
      throw new Error(`Facilitator ${path} failed with HTTP ${response.status}`)
    }
    return readJson(response)
  }

  async verify(input: {
    paymentPayload: X402PaymentPayload
    paymentRequirements: X402PaymentRequirement
  }) {
    const value = await this.post('/verify', input)
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
    const value = await this.post('/settle', input)
    if (
      value.success === true &&
      typeof value.transaction === 'string' &&
      typeof value.network === 'string' &&
      typeof value.payer === 'string'
    ) {
      return {
        success: true as const,
        transaction: value.transaction,
        network: value.network,
        payer: value.payer,
      }
    }
    return {
      success: false as const,
      reason: typeof value.errorReason === 'string' ? value.errorReason : 'settlement failed',
    }
  }
}
