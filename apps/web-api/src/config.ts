export type AppConfig = {
  runtimeMode: 'development' | 'test' | 'production'
  host: string
  port: number
  publicOrigin: string
  sessionCookieName: string
  signupSessionCookieName: string
  sessionAbsoluteTtlSeconds: number
  sessionIdleTtlSeconds: number
  signupSessionTtlSeconds: number
  bodyLimitBytes: number
  secureCookies: boolean
  trustProxyHops: number
  databaseUrl: string | undefined
  rateLimitHmacSecret: string
  oauth: OAuthConfig
  emailAuth: EmailAuthConfig
  signup: SignupCapability
  identityVerificationMode: 'disabled'
  upbitPdfImportEnabled: boolean
  engineMtls: EngineMtlsConfig | undefined
  engineInsecureTarget?: string
  privateObjectRoot?: string
  reportPayments?: ReportPaymentConfig
  privateObjectEncryptionKey?: Buffer
  privateObjectEncryptionKeyId?: string
  privateObjectLegacyKeyId?: string
  privateObjectDecryptionKeys?: ReadonlyMap<string, Buffer>
}

export type ReportPaymentConfig = {
  facilitatorUrl: string
  network: 'eip155:91342'
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  tokenName: string
  tokenVersion: string
}

export type SignupCapability = {
  enabled: boolean
  identityVerificationRequired: boolean
  methods: {
    email: boolean
    oauthProviders: ReadonlyArray<OAuthProviderName>
  }
}

export type OAuthProviderName = 'naver' | 'google' | 'kakao'

export type OAuthProviderConfig = {
  clientId: string
  clientSecret: string | undefined
}

export type OAuthConfig = {
  enabledProviders: ReadonlySet<OAuthProviderName>
  transactionTtlSeconds: number
  stateHmacSecret: string
  transactionEncryptionKey: Buffer
  providers: Partial<Record<OAuthProviderName, OAuthProviderConfig>>
}

export type EmailAuthConfig = {
  enabled: boolean
  resendApiKey: string | undefined
  from: string | undefined
  verificationHmacSecret: string
  verificationTtlSeconds: number
  verificationTokenTtlSeconds: number
  resendAfterSeconds: number
}

export type EngineMtlsConfig = {
  target: string
  caPath: string
  certPath: string
  keyPath: string
  serverNameOverride: string | undefined
}

const parsePositiveInteger = (value: string | undefined, fallback: number, name: string) => {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }

  return parsed
}

const parseOrigin = (value: string) => {
  const url = new URL(value)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PUBLIC_ORIGIN must contain only scheme, host, and optional port')
  }

  return url.origin
}

const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/

const loadReportPaymentConfig = (
  environment: NodeJS.ProcessEnv,
  production: boolean,
): ReportPaymentConfig | undefined => {
  const enabled = parseBoolean(
    environment.X402_REPORT_PAYMENTS_ENABLED,
    false,
    'X402_REPORT_PAYMENTS_ENABLED',
  )
  if (!enabled) return undefined

  const facilitatorUrl = environment.X402_FACILITATOR_URL
  const asset = environment.X402_ASSET_ADDRESS
  const payTo = environment.X402_PAY_TO_ADDRESS
  const amount = environment.X402_AMOUNT_ATOMIC
  if (!facilitatorUrl || !asset || !payTo || !amount) {
    throw new Error(
      'X402_FACILITATOR_URL, X402_ASSET_ADDRESS, X402_PAY_TO_ADDRESS and X402_AMOUNT_ATOMIC are required when report payments are enabled',
    )
  }
  const url = new URL(facilitatorUrl)
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('X402_FACILITATOR_URL must contain only scheme, host, and optional port')
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('X402_FACILITATOR_URL must use https in production')
  }
  if (!production && url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('X402_FACILITATOR_URL must use https or loopback http')
  }
  if (!evmAddressPattern.test(asset) || !evmAddressPattern.test(payTo)) {
    throw new Error('X402 asset and pay-to values must be EVM addresses')
  }
  if (!/^[1-9][0-9]*$/.test(amount)) {
    throw new Error('X402_AMOUNT_ATOMIC must be a positive integer string')
  }

  return {
    facilitatorUrl: url.origin,
    network: 'eip155:91342',
    asset,
    amount,
    payTo,
    maxTimeoutSeconds: parsePositiveInteger(
      environment.X402_MAX_TIMEOUT_SECONDS,
      300,
      'X402_MAX_TIMEOUT_SECONDS',
    ),
    tokenName: environment.X402_TOKEN_NAME ?? 'Mock USD',
    tokenVersion: environment.X402_TOKEN_VERSION ?? '1',
  }
}

const parseNonNegativeInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
) => {
  if (value === undefined) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return parsed
}

const parseBoolean = (value: string | undefined, fallback: boolean, name: string) => {
  if (value === undefined) {
    return fallback
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  throw new Error(`${name} must be true or false`)
}

const parseIdentityVerificationMode = (
  value: string | undefined,
) => {
  const mode = value ?? 'disabled'
  if (mode !== 'disabled') {
    throw new Error('IDENTITY_VERIFICATION_MODE must be disabled')
  }
  return 'disabled' as const
}

const oauthProviderNames = ['naver', 'google', 'kakao'] as const

const parseEnabledOAuthProviders = (value: string | undefined) => {
  const providers = new Set<OAuthProviderName>()
  for (const rawProvider of value?.split(',') ?? []) {
    const provider = rawProvider.trim()
    if (!provider) {
      continue
    }
    if (!oauthProviderNames.includes(provider as OAuthProviderName)) {
      throw new Error(`OAUTH_ENABLED_PROVIDERS contains unsupported provider: ${provider}`)
    }
    providers.add(provider as OAuthProviderName)
  }
  return providers
}

const parseEncryptionKey = (
  value: string | undefined,
  required: boolean,
): Buffer => {
  if (!value) {
    if (required) {
      throw new Error('OAUTH_TRANSACTION_ENCRYPTION_KEY is required')
    }
    return Buffer.alloc(32)
  }

  const key = Buffer.from(value, 'base64')
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
    throw new Error('OAUTH_TRANSACTION_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  }
  return key
}

const parsePrivateObjectEncryptionKey = (value: string | undefined) => {
  if (!value) return undefined
  const key = Buffer.from(value, 'base64')
  if (
    key.length !== 32 ||
    key.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')
  ) {
    throw new Error(
      'PRIVATE_OBJECT_ENCRYPTION_KEY must be a base64-encoded 32-byte key',
    )
  }
  return key
}

const parsePrivateObjectDecryptionKeys = (value: string | undefined) => {
  const keys = new Map<string, Buffer>()
  if (!value) return keys
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('PRIVATE_OBJECT_DECRYPTION_KEYS must be a JSON object')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('PRIVATE_OBJECT_DECRYPTION_KEYS must be a JSON object')
  }
  for (const [keyId, encodedKey] of Object.entries(parsed)) {
    const key = parsePrivateObjectEncryptionKey(
      typeof encodedKey === 'string' ? encodedKey : undefined,
    )
    if (!key || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      throw new Error('PRIVATE_OBJECT_DECRYPTION_KEYS contains an invalid entry')
    }
    keys.set(keyId, key)
  }
  return keys
}

const loadOAuthConfig = (
  environment: NodeJS.ProcessEnv,
  production: boolean,
): OAuthConfig => {
  const enabledProviders = parseEnabledOAuthProviders(
    environment.OAUTH_ENABLED_PROVIDERS,
  )
  const enabled = enabledProviders.size > 0
  const productionSecretsRequired = production && enabled
  const stateHmacSecret =
    environment.OAUTH_STATE_HMAC_SECRET ?? 'development-only-oauth-state-secret'
  if (
    productionSecretsRequired &&
    Buffer.byteLength(stateHmacSecret, 'utf8') < 32
  ) {
    throw new Error('OAUTH_STATE_HMAC_SECRET must contain at least 32 bytes in production')
  }

  const providers: Partial<Record<OAuthProviderName, OAuthProviderConfig>> = {}
  for (const provider of enabledProviders) {
    const prefix = provider.toUpperCase()
    const clientId = environment[`${prefix}_CLIENT_ID`]
    const clientSecret = environment[`${prefix}_CLIENT_SECRET`]
    if (!clientId) {
      throw new Error(`${prefix}_CLIENT_ID is required when ${provider} OAuth is enabled`)
    }
    if (!clientSecret) {
      throw new Error(`${prefix}_CLIENT_SECRET is required when ${provider} OAuth is enabled`)
    }
    providers[provider] = { clientId, clientSecret }
  }

  return {
    enabledProviders,
    transactionTtlSeconds: parsePositiveInteger(
      environment.OAUTH_TRANSACTION_TTL_SECONDS,
      600,
      'OAUTH_TRANSACTION_TTL_SECONDS',
    ),
    stateHmacSecret,
    transactionEncryptionKey: parseEncryptionKey(
      environment.OAUTH_TRANSACTION_ENCRYPTION_KEY,
      enabled,
    ),
    providers,
  }
}

const loadEmailAuthConfig = (
  environment: NodeJS.ProcessEnv,
  production: boolean,
): EmailAuthConfig => {
  const enabled = parseBoolean(environment.EMAIL_AUTH_ENABLED, false, 'EMAIL_AUTH_ENABLED')
  const verificationHmacSecret =
    environment.EMAIL_VERIFICATION_HMAC_SECRET ??
    'development-only-email-verification-secret'
  if (
    production &&
    enabled &&
    Buffer.byteLength(verificationHmacSecret, 'utf8') < 32
  ) {
    throw new Error(
      'EMAIL_VERIFICATION_HMAC_SECRET must contain at least 32 bytes in production',
    )
  }
  if (enabled && !environment.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is required when email authentication is enabled')
  }
  if (enabled && !environment.EMAIL_FROM) {
    throw new Error('EMAIL_FROM is required when email authentication is enabled')
  }

  return {
    enabled,
    resendApiKey: environment.RESEND_API_KEY,
    from: environment.EMAIL_FROM,
    verificationHmacSecret,
    verificationTtlSeconds: parsePositiveInteger(
      environment.EMAIL_VERIFICATION_TTL_SECONDS,
      300,
      'EMAIL_VERIFICATION_TTL_SECONDS',
    ),
    verificationTokenTtlSeconds: parsePositiveInteger(
      environment.EMAIL_VERIFICATION_TOKEN_TTL_SECONDS,
      600,
      'EMAIL_VERIFICATION_TOKEN_TTL_SECONDS',
    ),
    resendAfterSeconds: parsePositiveInteger(
      environment.EMAIL_VERIFICATION_RESEND_AFTER_SECONDS,
      60,
      'EMAIL_VERIFICATION_RESEND_AFTER_SECONDS',
    ),
  }
}

const loadEngineMtlsConfig = (
  environment: NodeJS.ProcessEnv,
  required: boolean,
): EngineMtlsConfig | undefined => {
  const entries = [
    ['ENGINE_GRPC_TARGET', environment.ENGINE_GRPC_TARGET],
    ['ENGINE_GRPC_CA_PATH', environment.ENGINE_GRPC_CA_PATH],
    ['ENGINE_GRPC_CERT_PATH', environment.ENGINE_GRPC_CERT_PATH],
    ['ENGINE_GRPC_KEY_PATH', environment.ENGINE_GRPC_KEY_PATH],
  ] as const
  const configured = entries.some(([, value]) => value !== undefined)
  if (!configured && !required) {
    return undefined
  }

  for (const [name, value] of entries) {
    if (!value) {
      throw new Error(`${name} is required`)
    }
  }

  if (environment.ENGINE_GRPC_TARGET?.includes('://')) {
    throw new Error('ENGINE_GRPC_TARGET must be a gRPC authority without an HTTP scheme')
  }

  return {
    target: environment.ENGINE_GRPC_TARGET as string,
    caPath: environment.ENGINE_GRPC_CA_PATH as string,
    certPath: environment.ENGINE_GRPC_CERT_PATH as string,
    keyPath: environment.ENGINE_GRPC_KEY_PATH as string,
    serverNameOverride: environment.ENGINE_GRPC_SERVER_NAME,
  }
}

const loadInsecureLoopbackEngineTarget = (
  environment: NodeJS.ProcessEnv,
  production: boolean,
) => {
  const target = environment.ENGINE_GRPC_INSECURE_TARGET
  if (!target) {
    return undefined
  }
  if (
    environment.ENGINE_GRPC_TARGET ||
    environment.ENGINE_GRPC_CA_PATH ||
    environment.ENGINE_GRPC_CERT_PATH ||
    environment.ENGINE_GRPC_KEY_PATH
  ) {
    throw new Error('Configure either Engine mTLS or a local Engine transport, not both')
  }
  const unixSocket = /^unix:(\/.+)$/.exec(target)
  if (unixSocket) {
    if (
      unixSocket[1]?.includes('/../') ||
      unixSocket[1]?.endsWith('/..') ||
      unixSocket[1]?.includes('/./')
    ) {
      throw new Error('ENGINE_GRPC_INSECURE_TARGET Unix socket path must be normalized')
    }
    return target
  }
  if (production) {
    throw new Error('plaintext TCP Engine transport is not allowed in production')
  }
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/.exec(target)
  if (!match || Number(match[1]) > 65_535) {
    throw new Error('ENGINE_GRPC_INSECURE_TARGET must be a loopback gRPC authority')
  }
  return target
}

export const loadConfig = (environment: NodeJS.ProcessEnv = process.env): AppConfig => {
  const runtimeMode = environment.NODE_ENV ?? 'development'
  if (!['development', 'test', 'production'].includes(runtimeMode)) {
    throw new Error('NODE_ENV must be development, test, or production')
  }

  const production = runtimeMode === 'production'
  const upbitPdfImportEnabled = parseBoolean(
    environment.UPBIT_PDF_IMPORT_ENABLED,
    false,
    'UPBIT_PDF_IMPORT_ENABLED',
  )
  const privateObjectEncryptionKey = parsePrivateObjectEncryptionKey(
    environment.PRIVATE_OBJECT_ENCRYPTION_KEY,
  )
  const privateObjectEncryptionKeyId = environment.PRIVATE_OBJECT_ENCRYPTION_KEY_ID
  const privateObjectLegacyKeyId = environment.PRIVATE_OBJECT_LEGACY_KEY_ID
  const privateObjectDecryptionKeys = parsePrivateObjectDecryptionKeys(
    environment.PRIVATE_OBJECT_DECRYPTION_KEYS,
  )
  if (
    privateObjectLegacyKeyId &&
    (!/^[A-Za-z0-9._-]{1,64}$/.test(privateObjectLegacyKeyId) ||
      (privateObjectLegacyKeyId !== privateObjectEncryptionKeyId &&
        !privateObjectDecryptionKeys.has(privateObjectLegacyKeyId)))
  ) {
    throw new Error(
      'PRIVATE_OBJECT_LEGACY_KEY_ID must identify the current key or an entry in PRIVATE_OBJECT_DECRYPTION_KEYS',
    )
  }
  if (
    production &&
    upbitPdfImportEnabled &&
    (!privateObjectEncryptionKey ||
      !privateObjectEncryptionKeyId ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(privateObjectEncryptionKeyId))
  ) {
    throw new Error(
      'PRIVATE_OBJECT_ENCRYPTION_KEY and PRIVATE_OBJECT_ENCRYPTION_KEY_ID are required when PDF import is enabled in production',
    )
  }
  const oauth = loadOAuthConfig(environment, production)
  const emailAuth = loadEmailAuthConfig(environment, production)
  const reportPayments = loadReportPaymentConfig(environment, production)
  const identityVerificationMode = parseIdentityVerificationMode(
    environment.IDENTITY_VERIFICATION_MODE,
  )
  const signupRequested = parseBoolean(
    environment.SIGNUP_ENABLED,
    false,
    'SIGNUP_ENABLED',
  )
  const signupMethods = {
    email: emailAuth.enabled,
    oauthProviders: [...oauth.enabledProviders],
  }
  if (
    signupRequested &&
    !signupMethods.email &&
    signupMethods.oauthProviders.length === 0
  ) {
    throw new Error('SIGNUP_ENABLED=true requires at least one configured signup method')
  }
  const signup: SignupCapability = signupRequested
    ? {
        enabled: true,
        identityVerificationRequired: false,
        methods: signupMethods,
      }
    : {
        enabled: false,
        identityVerificationRequired: false,
        methods: { email: false, oauthProviders: [] },
      }
  const engineInsecureTarget = loadInsecureLoopbackEngineTarget(
    environment,
    production,
  )
  if (production && environment.PUBLIC_ORIGIN === undefined) {
    throw new Error('PUBLIC_ORIGIN is required in production')
  }
  if (
    production &&
    environment.PUBLIC_ORIGIN !== undefined &&
    new URL(environment.PUBLIC_ORIGIN).protocol !== 'https:'
  ) {
    throw new Error('PUBLIC_ORIGIN must use https in production')
  }
  if (production && environment.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required in production')
  }
  if (production && environment.PRIVATE_OBJECT_ROOT === undefined) {
    throw new Error('PRIVATE_OBJECT_ROOT is required in production')
  }
  const rateLimitHmacSecret =
    environment.RATE_LIMIT_HMAC_SECRET ?? 'development-only-rate-limit-secret'
  if (production && Buffer.byteLength(rateLimitHmacSecret, 'utf8') < 32) {
    throw new Error('RATE_LIMIT_HMAC_SECRET must contain at least 32 bytes in production')
  }

  const sessionAbsoluteTtlSeconds = parsePositiveInteger(
    environment.SESSION_ABSOLUTE_TTL_SECONDS,
    60 * 60 * 24 * 7,
    'SESSION_ABSOLUTE_TTL_SECONDS',
  )
  const sessionIdleTtlSeconds = parsePositiveInteger(
    environment.SESSION_IDLE_TTL_SECONDS,
    60 * 60 * 12,
    'SESSION_IDLE_TTL_SECONDS',
  )
  if (sessionIdleTtlSeconds > sessionAbsoluteTtlSeconds) {
    throw new Error('SESSION_IDLE_TTL_SECONDS must not exceed SESSION_ABSOLUTE_TTL_SECONDS')
  }

  return {
    runtimeMode: runtimeMode as AppConfig['runtimeMode'],
    host: environment.HOST ?? '127.0.0.1',
    port: parsePositiveInteger(environment.PORT, 3000, 'PORT'),
    publicOrigin: parseOrigin(environment.PUBLIC_ORIGIN ?? 'http://localhost:5173'),
    sessionCookieName: production ? '__Host-daejang_session' : 'daejang_session',
    signupSessionCookieName: production
      ? '__Host-daejang_signup'
      : 'daejang_signup',
    sessionAbsoluteTtlSeconds,
    sessionIdleTtlSeconds,
    signupSessionTtlSeconds: parsePositiveInteger(
      environment.SIGNUP_SESSION_TTL_SECONDS,
      60 * 60,
      'SIGNUP_SESSION_TTL_SECONDS',
    ),
    bodyLimitBytes: parsePositiveInteger(
      environment.BODY_LIMIT_BYTES,
      1024 * 1024,
      'BODY_LIMIT_BYTES',
    ),
    secureCookies: production,
    trustProxyHops: parseNonNegativeInteger(
      environment.TRUST_PROXY_HOPS,
      production ? 1 : 0,
      'TRUST_PROXY_HOPS',
    ),
    databaseUrl: environment.DATABASE_URL,
    rateLimitHmacSecret,
    oauth,
    emailAuth,
    signup,
    identityVerificationMode,
    upbitPdfImportEnabled,
    engineMtls: loadEngineMtlsConfig(
      environment,
      production && engineInsecureTarget === undefined,
    ),
    ...(reportPayments ? { reportPayments } : {}),
    ...(environment.PRIVATE_OBJECT_ROOT ? { privateObjectRoot: environment.PRIVATE_OBJECT_ROOT } : {}),
    ...(privateObjectEncryptionKey ? { privateObjectEncryptionKey } : {}),
    ...(privateObjectEncryptionKeyId ? { privateObjectEncryptionKeyId } : {}),
    ...(privateObjectLegacyKeyId ? { privateObjectLegacyKeyId } : {}),
    ...(privateObjectDecryptionKeys.size > 0 ? { privateObjectDecryptionKeys } : {}),
    ...(engineInsecureTarget ? { engineInsecureTarget } : {}),
  }
}
