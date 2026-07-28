import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto'

import type {
  AppConfig,
  OAuthProviderConfig,
  OAuthProviderName,
} from '../config.js'
import { invalidOAuthTransaction, oauthProviderUnavailable } from '../errors.js'
import type {
  AccountAuthStore,
  OAuthIntent,
  OAuthTransactionRecord,
} from './account-auth-store.js'

export type NormalizedOAuthIdentity = {
  provider: OAuthProviderName
  providerSubject: string
  email: string | undefined
  emailVerified: boolean
}

export interface OAuthProviderAdapter {
  readonly provider: OAuthProviderName
  buildAuthorizationUrl(input: {
    client: OAuthProviderConfig
    redirectUri: string
    state: string
    nonce: string | undefined
    codeChallenge: string | undefined
  }): URL
  exchangeCode(input: {
    client: OAuthProviderConfig
    redirectUri: string
    code: string
    state: string
    nonce: string | undefined
    codeVerifier: string | undefined
  }): Promise<NormalizedOAuthIdentity>
}

type OAuthTransactionSecrets = {
  nonce?: string
  codeVerifier?: string
}

const base64UrlHash = (value: string) =>
  createHash('sha256').update(value).digest('base64url')

const hmac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url')

const encryptSecrets = (
  secrets: OAuthTransactionSecrets,
  encryptionKey: Buffer,
) => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const plaintext = Buffer.from(JSON.stringify(secrets), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

const decryptSecrets = (
  value: Buffer | undefined,
  encryptionKey: Buffer,
): OAuthTransactionSecrets => {
  if (!value) {
    return {}
  }
  if (value.length < 29) {
    throw invalidOAuthTransaction()
  }
  const iv = value.subarray(0, 12)
  const tag = value.subarray(12, 28)
  const ciphertext = value.subarray(28)
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString('utf8')
    const parsed: unknown = JSON.parse(plaintext)
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('OAuth transaction secrets are not an object')
    }
    const nonce = 'nonce' in parsed ? parsed.nonce : undefined
    const codeVerifier =
      'codeVerifier' in parsed ? parsed.codeVerifier : undefined
    if (
      (nonce !== undefined && typeof nonce !== 'string') ||
      (codeVerifier !== undefined && typeof codeVerifier !== 'string')
    ) {
      throw new Error('OAuth transaction secrets are invalid')
    }
    return {
      ...(nonce ? { nonce } : {}),
      ...(codeVerifier ? { codeVerifier } : {}),
    }
  } catch {
    throw invalidOAuthTransaction()
  }
}

export const normalizeReturnPath = (
  rawReturnPath: string | undefined,
  fallback = '/dashboard',
) => {
  if (!rawReturnPath) {
    return fallback
  }
  if (
    !rawReturnPath.startsWith('/') ||
    rawReturnPath.startsWith('//') ||
    rawReturnPath.includes('\\') ||
    rawReturnPath.length > 512
  ) {
    return fallback
  }
  try {
    const parsed = new URL(rawReturnPath, 'https://return-path.invalid')
    if (parsed.origin !== 'https://return-path.invalid' || parsed.hash) {
      return fallback
    }
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return fallback
  }
}

export class OAuthService {
  readonly #adapters = new Map<OAuthProviderName, OAuthProviderAdapter>()

  constructor(
    private readonly store: AccountAuthStore,
    private readonly config: AppConfig,
    adapters: ReadonlyArray<OAuthProviderAdapter>,
    private readonly now: () => Date = () => new Date(),
  ) {
    for (const adapter of adapters) {
      this.#adapters.set(adapter.provider, adapter)
    }
  }

  callbackUrl(provider: OAuthProviderName) {
    return new URL(
      `/api/v1/auth/oauth/${provider}/callback`,
      this.config.publicOrigin,
    ).toString()
  }

  async start(input: {
    provider: OAuthProviderName
    intent: OAuthIntent
    returnPath: string | undefined
    authenticatedUserId?: string | undefined
  }) {
    const adapter = this.#adapter(input.provider)
    const client = this.#client(input.provider)
    if (input.intent === 'link' && !input.authenticatedUserId) {
      throw invalidOAuthTransaction()
    }

    const state = randomBytes(32).toString('base64url')
    const usesOidc = input.provider !== 'naver'
    const nonce = usesOidc ? randomBytes(32).toString('base64url') : undefined
    const codeVerifier = usesOidc
      ? randomBytes(32).toString('base64url')
      : undefined
    const createdAt = this.now()
    const record: OAuthTransactionRecord = {
      id: randomUUID(),
      provider: input.provider,
      intent: input.intent,
      stateHash: hmac(this.config.oauth.stateHmacSecret, state),
      nonceHash: nonce
        ? hmac(this.config.oauth.stateHmacSecret, nonce)
        : undefined,
      pkceVerifierCiphertext:
        nonce || codeVerifier
          ? encryptSecrets(
              {
                ...(nonce ? { nonce } : {}),
                ...(codeVerifier ? { codeVerifier } : {}),
              },
              this.config.oauth.transactionEncryptionKey,
            )
          : undefined,
      authenticatedUserId: input.authenticatedUserId,
      returnPath: normalizeReturnPath(input.returnPath),
      createdAt,
      expiresAt: new Date(
        createdAt.getTime() +
          this.config.oauth.transactionTtlSeconds * 1_000,
      ),
      consumedAt: undefined,
    }
    await this.store.createOAuthTransaction(record)

    return adapter.buildAuthorizationUrl({
      client,
      redirectUri: this.callbackUrl(input.provider),
      state,
      nonce,
      codeChallenge: codeVerifier ? base64UrlHash(codeVerifier) : undefined,
    })
  }

  async complete(input: {
    provider: OAuthProviderName
    state: string
    code: string
  }) {
    const transaction = await this.store.consumeOAuthTransaction(
      hmac(this.config.oauth.stateHmacSecret, input.state),
      this.now(),
    )
    if (!transaction || transaction.provider !== input.provider) {
      throw invalidOAuthTransaction()
    }
    const secrets = decryptSecrets(
      transaction.pkceVerifierCiphertext,
      this.config.oauth.transactionEncryptionKey,
    )
    if (
      (transaction.nonceHash !== undefined) !==
      (secrets.nonce !== undefined)
    ) {
      throw invalidOAuthTransaction()
    }
    if (
      secrets.nonce &&
      hmac(this.config.oauth.stateHmacSecret, secrets.nonce) !==
        transaction.nonceHash
    ) {
      throw invalidOAuthTransaction()
    }

    const identity = await this.#adapter(input.provider).exchangeCode({
      client: this.#client(input.provider),
      redirectUri: this.callbackUrl(input.provider),
      code: input.code,
      state: input.state,
      nonce: secrets.nonce,
      codeVerifier: secrets.codeVerifier,
    })
    if (
      identity.provider !== input.provider ||
      !identity.providerSubject ||
      identity.providerSubject.length > 512
    ) {
      throw invalidOAuthTransaction()
    }
    return { transaction, identity }
  }

  async cancel(input: { provider: OAuthProviderName; state: string }) {
    const transaction = await this.store.consumeOAuthTransaction(
      hmac(this.config.oauth.stateHmacSecret, input.state),
      this.now(),
    )
    if (!transaction || transaction.provider !== input.provider) {
      throw invalidOAuthTransaction()
    }
    return transaction
  }

  #adapter(provider: OAuthProviderName) {
    const adapter = this.#adapters.get(provider)
    if (!this.config.oauth.enabledProviders.has(provider) || !adapter) {
      throw oauthProviderUnavailable()
    }
    return adapter
  }

  #client(provider: OAuthProviderName) {
    const client = this.config.oauth.providers[provider]
    if (!client) {
      throw oauthProviderUnavailable()
    }
    return client
  }
}
