import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import type { AppConfig } from '../config.js'
import {
  authNoticeCookieName,
  clearAuthNoticeCookie,
  clearOAuthTransactionCookie,
  clearSessionCookie,
  setAuthNoticeCookie,
  setOAuthTransactionCookie,
  setSessionCookie,
} from './auth-context.js'

const config: AppConfig = {
  runtimeMode: 'production',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'https://daejang.backwardlabs.io',
  sessionCookieName: '__Host-daejang_session',
  signupSessionCookieName: '__Host-daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1_024,
  secureCookies: true,
  trustProxyHops: 1,
  databaseUrl: 'postgresql://example.invalid/daejang',
  rateLimitHmacSecret: 'test-rate-limit-secret-at-least-32-bytes',
  oauth: {
    enabledProviders: new Set(),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'test-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {},
  },
  emailAuth: {
    enabled: false,
    resendApiKey: undefined,
    from: undefined,
    verificationHmacSecret: 'test-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: false,
    identityVerificationRequired: false,
    methods: { email: false, oauthProviders: [] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: false,
  engineMtls: {
    target: 'jit-engine.internal:8443',
    caPath: '/run/secrets/engine-ca.pem',
    certPath: '/run/secrets/client.pem',
    keyPath: '/run/secrets/client-key.pem',
    serverNameOverride: undefined,
  },
}

describe('session cookie policy', () => {
  it('uses matching host-only security attributes when setting and clearing', async () => {
    const app = Fastify({ logger: false })
    await app.register(cookie)
    app.get('/set', async (_request, reply) => {
      setSessionCookie(
        reply,
        'opaque-token',
        new Date('2027-07-20T01:00:00.000Z'),
        config,
      )
      return { ok: true }
    })
    app.get('/clear', async (_request, reply) => {
      clearSessionCookie(reply, config)
      return { ok: true }
    })

    const setHeader = (await app.inject('/set')).headers['set-cookie']
    const clearHeader = (await app.inject('/clear')).headers['set-cookie']
    await app.close()

    for (const header of [setHeader, clearHeader]) {
      expect(header).toContain('__Host-daejang_session=')
      expect(header).toContain('Path=/')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('Secure')
      expect(header).toContain('SameSite=Lax')
      expect(header).not.toContain('Domain=')
    }
  })

  it('binds OAuth transactions to a short-lived host-only browser cookie', async () => {
    const app = Fastify({ logger: false })
    await app.register(cookie)
    app.get('/set', async (_request, reply) => {
      setOAuthTransactionCookie(
        reply,
        'oauth-state',
        new Date('2027-07-20T00:10:00.000Z'),
        config,
      )
      return { ok: true }
    })
    app.get('/clear', async (_request, reply) => {
      clearOAuthTransactionCookie(reply, config)
      return { ok: true }
    })

    const setHeader = (await app.inject('/set')).headers['set-cookie']
    const clearHeader = (await app.inject('/clear')).headers['set-cookie']
    await app.close()

    expect(setHeader).toContain('__Host-daejang_oauth=oauth-state')
    for (const header of [setHeader, clearHeader]) {
      expect(header).toContain('Path=/')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('Secure')
      expect(header).toContain('SameSite=Lax')
      expect(header).not.toContain('Domain=')
    }
  })

  it('stores callback notices in a short-lived HttpOnly host cookie', async () => {
    const app = Fastify({ logger: false })
    await app.register(cookie)
    app.get('/set', async (_request, reply) => {
      setAuthNoticeCookie(
        reply,
        'oauth_access_denied',
        new Date('2027-07-20T00:02:00.000Z'),
        config,
      )
      return { ok: true }
    })
    app.get('/clear', async (_request, reply) => {
      clearAuthNoticeCookie(reply, config)
      return { ok: true }
    })

    const setHeader = (await app.inject('/set')).headers['set-cookie']
    const clearHeader = (await app.inject('/clear')).headers['set-cookie']
    await app.close()

    expect(authNoticeCookieName(config)).toBe('__Host-daejang_auth_notice')
    expect(setHeader).toContain(
      '__Host-daejang_auth_notice=oauth_access_denied',
    )
    for (const header of [setHeader, clearHeader]) {
      expect(header).toContain('Path=/')
      expect(header).toContain('HttpOnly')
      expect(header).toContain('Secure')
      expect(header).toContain('SameSite=Lax')
      expect(header).not.toContain('Domain=')
    }
  })
})
