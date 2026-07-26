import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import type { AppConfig } from '../config.js'
import { clearSessionCookie, setSessionCookie } from './auth-context.js'

const config: AppConfig = {
  runtimeMode: 'production',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'https://daejang.backwardlabs.io',
  sessionCookieName: '__Host-daejang_session',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  bodyLimitBytes: 1_024,
  secureCookies: true,
  trustProxyHops: 1,
  databaseUrl: 'postgresql://example.invalid/daejang',
  rateLimitHmacSecret: 'test-rate-limit-secret-at-least-32-bytes',
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
})
