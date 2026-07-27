import { afterEach, describe, expect, it, vi } from 'vitest'

import { handleRequest, type EdgeEnv } from './index'

const buildEnv = (overrides: Partial<EdgeEnv> = {}): EdgeEnv => ({
  ASSETS: {
    fetch: vi.fn(async () => new Response('asset')),
    connect: vi.fn(),
  },
  WEB_API_ORIGIN: 'https://api-origin.example.com',
  CF_ACCESS_CLIENT_ID: 'client-id',
  CF_ACCESS_CLIENT_SECRET: 'client-secret',
  ...overrides,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('edge routing', () => {
  it('serves non-API requests from the static asset binding', async () => {
    const env = buildEnv()

    const response = await handleRequest(new Request('https://daejang.example/terms'), env)

    expect(await response.text()).toBe('asset')
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce()
  })

  it('proxies API requests to the separate origin without exposing a redirect', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe(
        'https://api-origin.example.com/api/v1/auth/oauth/naver/callback?code=code&state=state',
      )
      expect(request.headers.get('CF-Access-Client-Id')).toBe('client-id')
      expect(request.headers.get('CF-Access-Client-Secret')).toBe('client-secret')
      expect(request.headers.get('X-Forwarded-Host')).toBe('daejang.example')
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/onboarding/terms',
          'Set-Cookie': '__Host-daejang_signup=value; Secure; HttpOnly; Path=/',
        },
      })
    })
    vi.stubGlobal('fetch', upstreamFetch)
    const env = buildEnv()

    const response = await handleRequest(
      new Request(
        'https://daejang.example/api/v1/auth/oauth/naver/callback?code=code&state=state',
        {
          headers: {
            'CF-Connecting-IP': '203.0.113.10',
            'X-Forwarded-For': '198.51.100.50',
          },
        },
      ),
      env,
    )

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/onboarding/terms')
    expect(response.headers.get('Set-Cookie')).toContain('__Host-daejang_signup')
    expect(upstreamFetch).toHaveBeenCalledOnce()
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('replaces an untrusted forwarded chain with Cloudflare client IP', async () => {
    const upstreamFetch = vi.fn(async (request: Request) => {
      expect(request.headers.get('X-Forwarded-For')).toBe('203.0.113.20')
      expect(request.headers.get('X-Real-IP')).toBeNull()
      return Response.json({ status: 'ok' })
    })
    vi.stubGlobal('fetch', upstreamFetch)

    await handleRequest(
      new Request('https://daejang.example/api/v1/me', {
        headers: {
          'CF-Connecting-IP': '203.0.113.20',
          'X-Forwarded-For': '198.51.100.60, 198.51.100.61',
          'X-Real-IP': '198.51.100.62',
        },
      }),
      buildEnv(),
    )

    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('fails closed when proxy bindings are missing', async () => {
    const env = buildEnv({ CF_ACCESS_CLIENT_SECRET: '' })

    const response = await handleRequest(
      new Request('https://daejang.example/api/v1/me'),
      env,
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'API_ORIGIN_NOT_CONFIGURED' },
    })
  })

  it('rejects a recursive public origin', async () => {
    const env = buildEnv({ WEB_API_ORIGIN: 'https://daejang.example' })

    const response = await handleRequest(
      new Request('https://daejang.example/api/v1/me'),
      env,
    )

    expect(response.status).toBe(503)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('rejects plaintext non-local API origins before sending Access secrets', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)
    const env = buildEnv({
      WEB_API_ORIGIN: 'http://api-origin.example.com',
    })

    const response = await handleRequest(
      new Request('https://daejang.example/api/v1/me'),
      env,
    )

    expect(response.status).toBe(503)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns a bounded error when the origin is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))))
    const env = buildEnv()

    const response = await handleRequest(
      new Request('https://daejang.example/api/v1/me'),
      env,
    )

    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
