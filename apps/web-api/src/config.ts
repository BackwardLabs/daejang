export type AppConfig = {
  runtimeMode: 'development' | 'test' | 'production'
  host: string
  port: number
  publicOrigin: string
  sessionCookieName: string
  sessionAbsoluteTtlSeconds: number
  sessionIdleTtlSeconds: number
  bodyLimitBytes: number
  secureCookies: boolean
  trustProxyHops: number
  databaseUrl: string | undefined
  rateLimitHmacSecret: string
  engineMtls: EngineMtlsConfig | undefined
  engineInsecureTarget?: string
  devBootstrapUser?: {
    id: string
    displayName: string
  }
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
  const engineInsecureTarget = loadDevelopmentEngineTarget(
    environment,
    production,
  )
  if (production && environment.PUBLIC_ORIGIN === undefined) {
    throw new Error('PUBLIC_ORIGIN is required in production')
  }
  if (production && environment.DATABASE_URL === undefined) {
    throw new Error('DATABASE_URL is required in production')
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
    sessionAbsoluteTtlSeconds,
    sessionIdleTtlSeconds,
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
    engineMtls: loadEngineMtlsConfig(environment, production),
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
