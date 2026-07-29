import { randomUUID } from 'node:crypto'

export type ReportPaymentBinding = {
  userId: string
  reportId: string
  residentId: string
  taxYear: number
  finality: 'FINAL'
  pointerVersion: number
  reportArtifactDigest: string
  format: 'json'
  resourceDigest: string
}

export type ReportPaymentTerms = {
  scheme: 'exact'
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
}

export type ReportPaymentOrder = ReportPaymentBinding &
  ReportPaymentTerms & {
    id: string
    state: 'QUOTED' | 'SETTLING' | 'SETTLED' | 'DELIVERED' | 'FAILED'
    expiresAt: Date
    payer?: string
    payloadHash?: string
    authorizationNonce?: string
    transactionHash?: string
    settlementLeaseUntil?: Date
  }

export type SettlementReservation =
  | { kind: 'reserved'; order: ReportPaymentOrder }
  | { kind: 'settled'; order: ReportPaymentOrder }
  | { kind: 'busy' }
  | { kind: 'invalid' }

export interface ReportPaymentStore {
  readonly durable: boolean
  findEntitlement(userId: string, resourceDigest: string, format: 'json'): Promise<boolean>
  getOrCreateQuote(
    binding: ReportPaymentBinding,
    terms: ReportPaymentTerms,
    expiresAt: Date,
  ): Promise<ReportPaymentOrder>
  reserveSettlement(input: {
    orderId: string
    userId: string
    resourceDigest: string
    payloadHash: string
    payer: string
    authorizationNonce: string
    now: Date
  }): Promise<SettlementReservation>
  completeSettlement(input: {
    orderId: string
    userId: string
    resourceDigest: string
    payer: string
    transactionHash: string
  }): Promise<ReportPaymentOrder>
  failSettlement(orderId: string, userId: string): Promise<void>
  markDelivered(orderId: string, userId: string): Promise<void>
}

export class MemoryReportPaymentStore implements ReportPaymentStore {
  readonly durable = false
  readonly orders = new Map<string, ReportPaymentOrder>()
  readonly entitlements = new Set<string>()
  readonly nonces = new Set<string>()

  private entitlementKey(userId: string, resourceDigest: string, format: 'json') {
    return `${userId}:${resourceDigest}:${format}`
  }

  async findEntitlement(userId: string, resourceDigest: string, format: 'json') {
    return this.entitlements.has(this.entitlementKey(userId, resourceDigest, format))
  }

  async getOrCreateQuote(
    binding: ReportPaymentBinding,
    terms: ReportPaymentTerms,
    expiresAt: Date,
  ) {
    const existing = [...this.orders.values()].find(
      (order) =>
        order.userId === binding.userId &&
        order.resourceDigest === binding.resourceDigest &&
        order.format === binding.format,
    )
    if (existing) {
      if (
        existing.state === 'SETTLING' ||
        existing.state === 'SETTLED' ||
        existing.state === 'DELIVERED' ||
        (existing.state === 'QUOTED' && existing.expiresAt.getTime() > Date.now())
      ) {
        return existing
      }
      Object.assign(existing, {
        ...binding,
        ...terms,
        state: 'QUOTED' as const,
        expiresAt,
        payer: undefined,
        payloadHash: undefined,
        authorizationNonce: undefined,
        transactionHash: undefined,
        settlementLeaseUntil: undefined,
      })
      return existing
    }

    const order: ReportPaymentOrder = {
      id: randomUUID(),
      ...binding,
      ...terms,
      state: 'QUOTED',
      expiresAt,
    }
    this.orders.set(order.id, order)
    return order
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
    const order = this.orders.get(input.orderId)
    if (
      !order ||
      order.userId !== input.userId ||
      order.resourceDigest !== input.resourceDigest ||
      order.expiresAt <= input.now ||
      order.state === 'FAILED'
    ) {
      return { kind: 'invalid' }
    }
    if (order.state === 'SETTLED' || order.state === 'DELIVERED') {
      return order.payloadHash === input.payloadHash
        ? { kind: 'settled', order }
        : { kind: 'invalid' }
    }
    if (order.state === 'SETTLING') {
      if (order.payloadHash !== input.payloadHash) return { kind: 'invalid' }
      if (order.settlementLeaseUntil && order.settlementLeaseUntil > input.now) {
        return { kind: 'busy' }
      }
      order.settlementLeaseUntil = new Date(input.now.getTime() + 30_000)
      return { kind: 'reserved', order }
    }
    if (this.nonces.has(`${order.network}:${input.authorizationNonce}`)) {
      return { kind: 'invalid' }
    }

    this.nonces.add(`${order.network}:${input.authorizationNonce}`)
    Object.assign(order, {
      state: 'SETTLING' as const,
      payloadHash: input.payloadHash,
      payer: input.payer,
      authorizationNonce: input.authorizationNonce,
      settlementLeaseUntil: new Date(input.now.getTime() + 30_000),
    })
    return { kind: 'reserved', order }
  }

  async completeSettlement(input: {
    orderId: string
    userId: string
    resourceDigest: string
    payer: string
    transactionHash: string
  }) {
    const order = this.orders.get(input.orderId)
    if (
      !order ||
      order.userId !== input.userId ||
      order.resourceDigest !== input.resourceDigest ||
      order.state !== 'SETTLING' ||
      order.payer?.toLowerCase() !== input.payer.toLowerCase()
    ) {
      throw new Error('Settlement does not match the reserved payment order')
    }
    Object.assign(order, {
      state: 'SETTLED' as const,
      transactionHash: input.transactionHash,
    })
    this.entitlements.add(
      this.entitlementKey(order.userId, order.resourceDigest, order.format),
    )
    return order
  }

  async failSettlement(orderId: string, userId: string) {
    const order = this.orders.get(orderId)
    if (order?.userId === userId && order.state === 'SETTLING') {
      order.state = 'FAILED'
    }
  }

  async markDelivered(orderId: string, userId: string) {
    const order = this.orders.get(orderId)
    if (order?.userId === userId && order.state === 'SETTLED') {
      order.state = 'DELIVERED'
    }
  }
}
