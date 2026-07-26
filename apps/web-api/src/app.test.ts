import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.js'
import { MemorySessionStore } from './auth/session.js'
import { MemoryRateLimitStore } from './auth/rate-limit.js'
import type { AppConfig } from './config.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'

const config: AppConfig = {
  runtimeMode: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  bodyLimitBytes: 1_024,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl: undefined,
  rateLimitHmacSecret: 'test-rate-limit-secret',
  engineMtls: undefined,
}

class TestDurableSessionStore extends MemorySessionStore {
  override readonly durable = true
}

class TestDurableRateLimitStore extends MemoryRateLimitStore {
  override readonly durable = true
}

describe('web api authentication boundary', () => {
  let now: Date
  let context: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    now = new Date('2027-07-20T00:00:00.000Z')
    context = await buildApp({ config, logger: false, now: () => now })
  })

  afterEach(async () => {
    await context.app.close()
  })

  const createSession = async () => {
    const session = {
      user: { id: USER_ID, displayName: '김대장' },
    } as const

    return context.sessionService.create(session)
  }

  it('serves health checks without a session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/healthz' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('rejects protected requests without a session', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/api/v1/me' })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({
      error: { code: 'AUTHENTICATION_REQUIRED' },
    })
  })

  it('returns only the identity resolved from the server session', async () => {
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        'x-user-id': '00000000-0000-4000-8000-000000000099',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      user: { id: USER_ID, displayName: '김대장' },
    })
  })

  it('does not expose a workspace API', async () => {
    const { token } = await createSession()

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/workspaces/00000000-0000-4000-8000-000000000099',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toMatchObject({ message: 'Route GET:/api/v1/workspaces/00000000-0000-4000-8000-000000000099 not found' })
  })

  it('rejects idle-expired sessions and clears their cookie', async () => {
    const { token } = await createSession()
    now = new Date(now.getTime() + config.sessionIdleTtlSeconds * 1_000)

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers['set-cookie']).toContain(`${config.sessionCookieName}=;`)
  })

  it('requires an exact same-origin header before logout', async () => {
    const { token } = await createSession()

    const rejected = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: 'https://attacker.example',
      },
    })
    expect(rejected.statusCode).toBe(403)

    const accepted = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
    })
    expect(accepted.statusCode).toBe(204)

    const afterLogout = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(afterLogout.statusCode).toBe(401)
  })

  it('rotates the session cookie and immediately rejects the previous token', async () => {
    const { token } = await createSession()
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/session/rotate',
      headers: {
        cookie: `${config.sessionCookieName}=${token}`,
        origin: config.publicOrigin,
      },
    })

    expect(response.statusCode).toBe(204)
    const setCookie = response.headers['set-cookie']
    expect(setCookie).toContain(`${config.sessionCookieName}=`)
    expect(setCookie).not.toContain(`${config.sessionCookieName}=${token}`)

    const rejected = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${config.sessionCookieName}=${token}` },
    })
    expect(rejected.statusCode).toBe(401)
  })

  it('does not clear the winning cookie when concurrent rotation loses', async () => {
    const { token } = await createSession()
    const request = () =>
      context.app.inject({
        method: 'POST',
        url: '/api/v1/auth/session/rotate',
        headers: {
          cookie: `${config.sessionCookieName}=${token}`,
          origin: config.publicOrigin,
        },
      })
    const responses = await Promise.all([request(), request()])
    const success = responses.find(({ statusCode }) => statusCode === 204)
    const conflict = responses.find(({ statusCode }) => statusCode === 409)

    expect(success?.headers['set-cookie']).toContain(`${config.sessionCookieName}=`)
    expect(conflict?.headers['set-cookie']).toBeUndefined()
    expect(conflict?.json()).toMatchObject({
      error: { code: 'SESSION_ROTATION_CONFLICT' },
    })
  })

  it.each([
    ['missing Origin', undefined, undefined],
    ['null Origin', 'null', undefined],
    ['mismatched Origin', 'https://attacker.example', undefined],
    ['same-site fetch', config.publicOrigin, 'same-site'],
    ['cross-site fetch', config.publicOrigin, 'cross-site'],
    ['none fetch', config.publicOrigin, 'none'],
    ['unknown fetch', config.publicOrigin, 'unexpected'],
  ])('rejects unsafe API requests with %s', async (_label, origin, fetchSite) => {
    const headers: Record<string, string> = {}
    if (origin) {
      headers.origin = origin
    }
    if (fetchSite) {
      headers['sec-fetch-site'] = fetchSite
    }

    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/unregistered',
      headers,
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST_ORIGIN' } })
  })

  it.each([
    ['Origin fallback', undefined],
    ['same-origin fetch', 'same-origin'],
  ])('allows unsafe requests with exact Origin and %s', async (_label, fetchSite) => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/unregistered',
      headers: {
        origin: config.publicOrigin,
        ...(fetchSite ? { 'sec-fetch-site': fetchSite } : {}),
      },
    })

    expect(response.statusCode).toBe(404)
  })

  it('does not apply the unsafe-method guard to OPTIONS', async () => {
    const response = await context.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/unregistered',
    })

    expect(response.statusCode).toBe(404)
  })

  it('adds security headers to public and API error responses', async () => {
    const health = await context.app.inject({ method: 'GET', url: '/healthz' })
    const unauthorizedResponse = await context.app.inject({
      method: 'GET',
      url: '/api/v1/me',
    })
    const notFound = await context.app.inject({
      method: 'GET',
      url: '/api/v1/unregistered',
    })

    for (const response of [health, unauthorizedResponse, notFound]) {
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      )
      expect(response.headers['x-content-type-options']).toBe('nosniff')
      expect(response.headers['x-frame-options']).toBe('DENY')
      expect(response.headers['referrer-policy']).toBe('no-referrer')
      expect(response.headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=()',
      )
    }

    expect(health.headers['cache-control']).toBeUndefined()
    expect(unauthorizedResponse.headers['cache-control']).toBe('no-store')
    expect(notFound.headers['cache-control']).toBe('no-store')
  })

  it('adds security and cache headers to unexpected API errors', async () => {
    context.app.get('/api/v1/test-error', async () => {
      throw new Error('test failure')
    })

    const response = await context.app.inject({ method: 'GET', url: '/api/v1/test-error' })

    expect(response.statusCode).toBe(500)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
  })

  it('rejects oversized bodies before authentication', async () => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        origin: config.publicOrigin,
        'content-type': 'text/plain',
      },
      payload: 'x'.repeat(config.bodyLimitBytes + 1),
    })

    expect(response.statusCode).toBe(413)
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('refuses production startup without a durable session store', async () => {
    await context.app.close()
    await expect(
      buildApp({
        config: {
          ...config,
          runtimeMode: 'production',
          secureCookies: true,
          sessionCookieName: '__Host-daejang_session',
        },
        logger: false,
      }),
    ).rejects.toThrow('durable SessionStore')

    await expect(
      buildApp({
        config: {
          ...config,
          runtimeMode: 'production',
          secureCookies: true,
          sessionCookieName: '__Host-daejang_session',
        },
        logger: false,
        sessionStore: new MemorySessionStore(),
        rateLimitStore: new MemoryRateLimitStore(),
      }),
    ).rejects.toThrow('durable SessionStore')

    const productionContext = await buildApp({
      config: {
        ...config,
        runtimeMode: 'production',
        secureCookies: true,
        sessionCookieName: '__Host-daejang_session',
      },
      logger: false,
      sessionStore: new TestDurableSessionStore(),
      rateLimitStore: new TestDurableRateLimitStore(),
    })
    const health = await productionContext.app.inject('/healthz')
    expect(health.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    )
    await productionContext.app.close()

    context = await buildApp({ config, logger: false, now: () => now })
  })
})
