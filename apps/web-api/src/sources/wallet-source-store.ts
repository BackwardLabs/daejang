export type WalletSourceStatus = 'ACTIVE' | 'DISCONNECTED'
export type WalletChainScopeStatus = 'ACTIVE' | 'DISABLED'

export type WalletChainScope = {
  chainId: string
  status: WalletChainScopeStatus
}

export type WalletSource = {
  id: string
  address: string
  accountType: 'EOA'
  verificationChainId: string
  verifiedAt: Date
  label: string | undefined
  status: WalletSourceStatus
  createdAt: Date
  updatedAt: Date
  disconnectedAt: Date | undefined
  chainScopes: WalletChainScope[]
}

export type WalletOwnershipChallenge = {
  id: string
  userId: string
  address: string
  verificationChainId: string
  message: string
  issuedAt: Date
  expiresAt: Date
  consumedAt: Date | undefined
}

export type SourceRequestContext = {
  requestId: string
  userId: string
  sessionId: string
  idempotencyKey?: string
}

export type CompleteWalletRegistration = {
  challengeId: string
  userId: string
  recoveredAddress: string
  verificationChainId: string
  chainIds: string[]
  label: string | undefined
  now: Date
  requestId: string
  sessionId: string
  idempotencyKey: string
}

export interface WalletSourceRegistry {
  readonly durable: boolean
  registerWallet(input: CompleteWalletRegistration): Promise<WalletSource>
  listWallets(context: SourceRequestContext): Promise<WalletSource[]>
  disconnectWallet(
    context: SourceRequestContext,
    sourceId: string,
    now: Date,
  ): Promise<WalletSource | undefined>
}

export interface WalletSourceStore {
  readonly durable: boolean
  createChallenge(challenge: WalletOwnershipChallenge): Promise<void>
  getChallenge(
    userId: string,
    challengeId: string,
  ): Promise<WalletOwnershipChallenge | undefined>
  completeRegistration(
    input: CompleteWalletRegistration,
  ): Promise<WalletSource | undefined>
  listWallets(context: SourceRequestContext): Promise<WalletSource[]>
  disconnectWallet(
    context: SourceRequestContext,
    sourceId: string,
    now: Date,
  ): Promise<WalletSource | undefined>
}

export class MemoryWalletSourceStore
  implements WalletSourceStore, WalletSourceRegistry
{
  readonly durable: boolean = false
  readonly #challenges = new Map<string, WalletOwnershipChallenge>()
  readonly #sources = new Map<string, WalletSource & { userId: string }>()

  async createChallenge(challenge: WalletOwnershipChallenge) {
    this.#challenges.set(challenge.id, { ...challenge })
  }

  async getChallenge(userId: string, challengeId: string) {
    const challenge = this.#challenges.get(challengeId)
    return challenge?.userId === userId ? { ...challenge } : undefined
  }

  async completeRegistration(input: CompleteWalletRegistration) {
    const challenge = this.#challenges.get(input.challengeId)
    if (
      !challenge ||
      challenge.userId !== input.userId ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= input.now.getTime() ||
      challenge.address !== input.recoveredAddress ||
      challenge.verificationChainId !== input.verificationChainId
    ) {
      return undefined
    }

    challenge.consumedAt = input.now
    return this.registerWallet(input)
  }

  async registerWallet(input: CompleteWalletRegistration) {
    const existing = [...this.#sources.values()].find(
      (source) =>
        source.userId === input.userId && source.address === input.recoveredAddress,
    )
    const source: WalletSource & { userId: string } = {
      id: existing?.id ?? crypto.randomUUID(),
      userId: input.userId,
      address: input.recoveredAddress,
      accountType: 'EOA',
      verificationChainId: input.verificationChainId,
      verifiedAt: input.now,
      label: input.label ?? existing?.label,
      status: 'ACTIVE',
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
      disconnectedAt: undefined,
      chainScopes: input.chainIds.map((chainId) => ({
        chainId,
        status: 'ACTIVE',
      })),
    }
    this.#sources.set(source.id, source)
    return this.#withoutUserId(source)
  }

  async listWallets(context: SourceRequestContext) {
    return [...this.#sources.values()]
      .filter((source) => source.userId === context.userId)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map((source) => this.#withoutUserId(source))
  }

  async disconnectWallet(
    context: SourceRequestContext,
    sourceId: string,
    now: Date,
  ) {
    const source = this.#sources.get(sourceId)
    if (!source || source.userId !== context.userId) {
      return undefined
    }

    const disconnected: WalletSource & { userId: string } = {
      ...source,
      status: 'DISCONNECTED',
      updatedAt: now,
      disconnectedAt: now,
      chainScopes: source.chainScopes.map((scope) => ({
        ...scope,
        status: 'DISABLED',
      })),
    }
    this.#sources.set(sourceId, disconnected)
    return this.#withoutUserId(disconnected)
  }

  #withoutUserId(source: WalletSource & { userId: string }): WalletSource {
    const { userId: _userId, ...walletSource } = source
    return {
      ...walletSource,
      chainScopes: walletSource.chainScopes.map((scope) => ({ ...scope })),
    }
  }
}
