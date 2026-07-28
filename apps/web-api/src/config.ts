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
  identityVerificationMode: 'disabled' | 'mock'
  engineMtls: EngineMtlsConfig | undefined
  engineInsecureTarget?: string
  privateObjectRoot?: string
  devBootstrapUser?: {
    id: string
    displayName: string
  }
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
  production: boolean,
) => {
  const mode = value ?? 'disabled'
  if (!['disabled', 'mock'].includes(mode)) {
    throw new Error('IDENTITY_VERIFICATION_MODE must be disabled or mock')
  }
  if (production && mode === 'mock') {
    throw new Error('IDENTITY_VERIFICATION_MODE=mock is not allowed in production')
  }
  return mode as AppConfig['identityVerificationMode']
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

const loadDevelopmentEngineTarget = (
  environment: NodeJS.ProcessEnv,
  production: boolean,
) => {
  const target = environment.ENGINE_GRPC_INSECURE_TARGET
  if (!target) {
    return undefined
  }
  if (production) {
    throw new Error('ENGINE_GRPC_INSECURE_TARGET is not allowed in production')
  }
  if (
    environment.ENGINE_GRPC_TARGET ||
    environment.ENGINE_GRPC_CA_PATH ||
    environment.ENGINE_GRPC_CERT_PATH ||
    environment.ENGINE_GRPC_KEY_PATH
  ) {
    throw new Error('Configure either Engine mTLS or insecure loopback, not both')
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
  const oauth = loadOAuthConfig(environment, production)
  const emailAuth = loadEmailAuthConfig(environment, production)
  const identityVerificationMode = parseIdentityVerificationMode(
    environment.IDENTITY_VERIFICATION_MODE,
    production,
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
        identityVerificationRequired: identityVerificationMode !== 'disabled',
        methods: signupMethods,
      }
    : {
        enabled: false,
        identityVerificationRequired: false,
        methods: { email: false, oauthProviders: [] },
      }
  const engineInsecureTarget = loadDevelopmentEngineTarget(
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
  if (
    production &&
    (environment.DEV_BOOTSTRAP_USER_ID || environment.DEV_BOOTSTRAP_DISPLAY_NAME)
  ) {
    throw new Error('Development session bootstrap must not be enabled in production')
  }

  const devBootstrapUserId = environment.DEV_BOOTSTRAP_USER_ID
  const devBootstrapDisplayName = environment.DEV_BOOTSTRAP_DISPLAY_NAME
  if (
    (devBootstrapUserId === undefined) !==
    (devBootstrapDisplayName === undefined)
  ) {
    throw new Error(
      'DEV_BOOTSTRAP_USER_ID and DEV_BOOTSTRAP_DISPLAY_NAME must be configured together',
    )
  }
  if (
    devBootstrapUserId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      devBootstrapUserId,
    )
  ) {
    throw new Error('DEV_BOOTSTRAP_USER_ID must be a UUID')
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
    engineMtls: loadEngineMtlsConfig(environment, production),
    ...(environment.PRIVATE_OBJECT_ROOT ? { privateObjectRoot: environment.PRIVATE_OBJECT_ROOT } : {}),
    ...(engineInsecureTarget ? { engineInsecureTarget } : {}),
    ...(devBootstrapUserId && devBootstrapDisplayName
      ? {
          devBootstrapUser: {
            id: devBootstrapUserId,
            displayName: devBootstrapDisplayName,
          },
        }
      : {}),
  }
}
