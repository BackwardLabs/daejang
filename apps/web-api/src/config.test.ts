import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { loadConfig } from './config.js'

describe('web api configuration', () => {
  it('documents every setting needed to activate signup and email authentication', () => {
    const example = readFileSync(
      new URL('../.env.example', import.meta.url),
      'utf8',
    )
    const documentedKeys = new Set(
      example
        .split(/\r?\n/u)
        .map((line) => /^([A-Z0-9_]+)=/u.exec(line)?.[1])
        .filter((key): key is string => key !== undefined),
    )

    expect([...documentedKeys]).toEqual(
      expect.arrayContaining([
        'SIGNUP_SESSION_TTL_SECONDS',
        'SIGNUP_ENABLED',
        'EMAIL_AUTH_ENABLED',
        'RESEND_API_KEY',
        'EMAIL_FROM',
        'EMAIL_VERIFICATION_HMAC_SECRET',
        'EMAIL_VERIFICATION_TTL_SECONDS',
        'EMAIL_VERIFICATION_TOKEN_TTL_SECONDS',
        'EMAIL_VERIFICATION_RESEND_AFTER_SECONDS',
        'IDENTITY_VERIFICATION_MODE',
      ]),
    )
  })

  it('uses a host-only secure cookie name in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      DATABASE_URL: 'postgresql://example.invalid/daejang',
      PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      ENGINE_GRPC_TARGET: 'jit-engine.internal:8443',
      ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
      ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
      ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
    })

    expect(config.sessionCookieName).toBe('__Host-daejang_session')
    expect(config.secureCookies).toBe(true)
    expect(config.runtimeMode).toBe('production')
  })

  it('rejects public origins containing a path', () => {
    expect(() =>
      loadConfig({ PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io/app' }),
    ).toThrow('PUBLIC_ORIGIN')
  })

  it('requires an explicit public origin in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('PUBLIC_ORIGIN')
  })

  it('requires an HTTPS public origin in production but allows HTTP localhost in development', () => {
    expect(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:5173' }).publicOrigin).toBe(
      'http://localhost:5173',
    )
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'http://daejang.backwardlabs.io',
      }),
    ).toThrow('https')
  })

  it('validates enabled OAuth providers and their independent encryption key', () => {
    expect(() =>
      loadConfig({ OAUTH_ENABLED_PROVIDERS: 'github' }),
    ).toThrow('unsupported provider')
    expect(() =>
      loadConfig({
        OAUTH_ENABLED_PROVIDERS: 'naver',
        NAVER_CLIENT_ID: 'client-id',
      }),
    ).toThrow('NAVER_CLIENT_SECRET')
    expect(() =>
      loadConfig({
        OAUTH_ENABLED_PROVIDERS: 'naver',
        NAVER_CLIENT_ID: 'client-id',
        NAVER_CLIENT_SECRET: 'client-secret',
        OAUTH_TRANSACTION_ENCRYPTION_KEY: 'not-a-32-byte-key',
      }),
    ).toThrow('base64-encoded 32-byte key')
  })

  it('requires durable PostgreSQL, rate-limit, and Engine mTLS settings in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      }),
    ).toThrow('DATABASE_URL')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'short',
      }),
    ).toThrow('RATE_LIMIT_HMAC_SECRET')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
      }),
    ).toThrow('ENGINE_GRPC_TARGET')
  })

  it('rejects an HTTP URL as an Engine gRPC target', () => {
    expect(() =>
      loadConfig({
        ENGINE_GRPC_TARGET: 'https://jit-engine.internal:8443',
        ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
        ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
        ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
      }),
    ).toThrow('gRPC authority')
  })

  it('allows plaintext Engine transport only on development loopback', () => {
    expect(
      loadConfig({
        NODE_ENV: 'development',
        ENGINE_GRPC_INSECURE_TARGET: '127.0.0.1:50051',
      }).engineInsecureTarget,
    ).toBe('127.0.0.1:50051')

    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        ENGINE_GRPC_INSECURE_TARGET: 'engine.internal:50051',
      }),
    ).toThrow('loopback')
  })

  it('rejects plaintext Engine transport in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        ENGINE_GRPC_INSECURE_TARGET: '127.0.0.1:50051',
      }),
    ).toThrow('not allowed in production')
  })

  it('rejects idle timeouts longer than the absolute timeout', () => {
    expect(() =>
      loadConfig({
        SESSION_ABSOLUTE_TTL_SECONDS: '60',
        SESSION_IDLE_TTL_SECONDS: '61',
      }),
    ).toThrow('must not exceed')
  })

  it('rejects unknown runtime modes', () => {
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow('NODE_ENV')
  })

  it('loads the development bootstrap user only when both values are present', () => {
    expect(
      loadConfig({
        DEV_BOOTSTRAP_USER_ID: '00000000-0000-4000-8000-000000000001',
        DEV_BOOTSTRAP_DISPLAY_NAME: '김대장',
      }).devBootstrapUser,
    ).toEqual({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '김대장',
    })

    expect(() =>
      loadConfig({ DEV_BOOTSTRAP_DISPLAY_NAME: '김대장' }),
    ).toThrow('configured together')
  })

  it('rejects development session bootstrap in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        DEV_BOOTSTRAP_USER_ID: '00000000-0000-4000-8000-000000000001',
        DEV_BOOTSTRAP_DISPLAY_NAME: '김대장',
      }),
    ).toThrow('must not be enabled in production')
  })

  it('allows mock identity verification outside production only', () => {
    expect(
      loadConfig({
        NODE_ENV: 'development',
        IDENTITY_VERIFICATION_MODE: 'mock',
      }).identityVerificationMode,
    ).toBe('mock')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
        IDENTITY_VERIFICATION_MODE: 'mock',
      }),
    ).toThrow('not allowed in production')
  })

  it('enables signup only with an explicit method and reports whether identity verification is required', () => {
    const enabled = loadConfig({
      SIGNUP_ENABLED: 'true',
      EMAIL_AUTH_ENABLED: 'true',
      RESEND_API_KEY: 'test-resend-key',
      EMAIL_FROM: 'GIWA <test@example.com>',
      IDENTITY_VERIFICATION_MODE: 'mock',
    })
    expect(enabled.signup).toEqual({
      enabled: true,
      identityVerificationRequired: true,
      methods: { email: true, oauthProviders: [] },
    })

    expect(loadConfig().signup).toEqual({
      enabled: false,
      identityVerificationRequired: false,
      methods: { email: false, oauthProviders: [] },
    })
    expect(() =>
      loadConfig({
        SIGNUP_ENABLED: 'true',
        IDENTITY_VERIFICATION_MODE: 'mock',
      }),
    ).toThrow('at least one configured signup method')
    expect(
      loadConfig({
        SIGNUP_ENABLED: 'true',
        EMAIL_AUTH_ENABLED: 'true',
        RESEND_API_KEY: 'test-resend-key',
        EMAIL_FROM: 'GIWA <test@example.com>',
        IDENTITY_VERIFICATION_MODE: 'disabled',
      }).signup,
    ).toEqual({
      enabled: true,
      identityVerificationRequired: false,
      methods: { email: true, oauthProviders: [] },
    })
  })

  it('allows explicit production signup without collecting mock identity results', () => {
    expect(
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
        PRIVATE_OBJECT_ROOT: '/var/lib/daejang/private',
        RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-at-least-32-bytes',
        ENGINE_GRPC_TARGET: 'jit-engine.internal:8443',
        ENGINE_GRPC_CA_PATH: '/run/secrets/engine-ca.pem',
        ENGINE_GRPC_CERT_PATH: '/run/secrets/client.pem',
        ENGINE_GRPC_KEY_PATH: '/run/secrets/client-key.pem',
        SIGNUP_ENABLED: 'true',
        EMAIL_AUTH_ENABLED: 'true',
        RESEND_API_KEY: 'test-resend-key',
        EMAIL_FROM: 'GIWA <test@example.com>',
        IDENTITY_VERIFICATION_MODE: 'disabled',
      }),
    ).toMatchObject({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: [] },
      },
      identityVerificationMode: 'disabled',
    })
  })
})
