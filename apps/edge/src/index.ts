export type EdgeEnv = {
  ASSETS: Fetcher
  WEB_API_ORIGIN: string
  CF_ACCESS_CLIENT_ID: string
  CF_ACCESS_CLIENT_SECRET: string
}

const API_PREFIX = '/api/'
const UPSTREAM_TIMEOUT_MS = 15_000

const jsonError = (status: number, code: string, message: string) =>
  Response.json(
    {
      error: {
        code,
        message,
        fieldErrors: [],
      },
    },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  )

const parseOrigin = (value: string) => {
  const origin = new URL(value)
  if (origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('WEB_API_ORIGIN must contain only scheme, host, and optional port')
  }
  if (!['http:', 'https:'].includes(origin.protocol)) {
    throw new Error('WEB_API_ORIGIN must use HTTP or HTTPS')
  }
  const localHttpHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
  if (origin.protocol === 'http:' && !localHttpHosts.has(origin.hostname)) {
    throw new Error('Non-local WEB_API_ORIGIN must use HTTPS')
  }
  return origin
}

const assertProxyConfiguration = (requestUrl: URL, env: EdgeEnv) => {
  if (
    !env.WEB_API_ORIGIN ||
    !env.CF_ACCESS_CLIENT_ID ||
    !env.CF_ACCESS_CLIENT_SECRET
  ) {
    throw new Error('Web API proxy bindings are incomplete')
  }

  const upstreamOrigin = parseOrigin(env.WEB_API_ORIGIN)
  if (upstreamOrigin.origin === requestUrl.origin) {
    throw new Error('WEB_API_ORIGIN must not point back to the public Worker origin')
  }
  return upstreamOrigin
}

const proxyApiRequest = async (request: Request, env: EdgeEnv) => {
  const publicUrl = new URL(request.url)
  let upstreamOrigin: URL
  try {
    upstreamOrigin = assertProxyConfiguration(publicUrl, env)
  } catch {
    return jsonError(
      503,
      'API_ORIGIN_NOT_CONFIGURED',
      '인증 서버 연결이 준비되지 않았습니다.',
    )
  }

  const upstreamUrl = new URL(`${publicUrl.pathname}${publicUrl.search}`, upstreamOrigin)
  const headers = new Headers(request.headers)
  const clientIp = request.headers.get('CF-Connecting-IP')
  headers.delete('CF-Access-Client-Id')
  headers.delete('CF-Access-Client-Secret')
  headers.delete('Host')
  headers.delete('X-Forwarded-For')
  headers.delete('X-Real-IP')
  headers.set('CF-Access-Client-Id', env.CF_ACCESS_CLIENT_ID)
  headers.set('CF-Access-Client-Secret', env.CF_ACCESS_CLIENT_SECRET)
  headers.set('X-Forwarded-Host', publicUrl.host)
  headers.set('X-Forwarded-Proto', publicUrl.protocol.slice(0, -1))
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp)
  }

  const upstreamRequest = new Request(upstreamUrl, {
    method: request.method,
    headers,
    body: request.body,
    redirect: 'manual',
  })

  try {
    return await fetch(upstreamRequest, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch {
    return jsonError(
      502,
      'API_ORIGIN_UNAVAILABLE',
      '인증 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    )
  }
}

export const handleRequest = (request: Request, env: EdgeEnv) => {
  const url = new URL(request.url)
  if (url.pathname.startsWith(API_PREFIX)) {
    return proxyApiRequest(request, env)
  }
  return env.ASSETS.fetch(request)
}

export default {
  fetch(request: Request, env: EdgeEnv) {
    return handleRequest(request, env)
  },
} satisfies ExportedHandler<EdgeEnv>
