import { describe, expect, it } from 'vitest'

import { loadConfig } from './config.js'

describe('web api configuration', () => {
  it('uses a host-only secure cookie name in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
      DATABASE_URL: 'postgresql://example.invalid/daejang',
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
        RATE_LIMIT_HMAC_SECRET: 'short',
      }),
    ).toThrow('RATE_LIMIT_HMAC_SECRET')

    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PUBLIC_ORIGIN: 'https://daejang.backwardlabs.io',
        DATABASE_URL: 'postgresql://example.invalid/daejang',
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
})
