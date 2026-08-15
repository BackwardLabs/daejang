import type { FastifyInstance } from 'fastify'

import type { AppConfig } from './config.js'
import { invalidOrigin } from './errors.js'

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const securityHeaders = {
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export const isAllowedRequestOrigin = (
  requestOrigin: string | undefined,
  config: AppConfig,
) => {
  if (requestOrigin === config.publicOrigin) {
    return true
  }
  if (config.runtimeMode !== 'development' || requestOrigin === undefined) {
    return false
  }

  try {
    const requestUrl = new URL(requestOrigin)
    const publicUrl = new URL(config.publicOrigin)
    return (
      requestUrl.origin === requestOrigin &&
      requestUrl.protocol === publicUrl.protocol &&
      requestUrl.hostname === publicUrl.hostname
    )
  } catch {
    return false
  }
}

export const registerSecurityPolicy = async (app: FastifyInstance, config: AppConfig) => {
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/api/') || !unsafeMethods.has(request.method)) {
      return
    }

    if (!isAllowedRequestOrigin(request.headers.origin, config)) {
      throw invalidOrigin()
    }

    const fetchSite = request.headers['sec-fetch-site']
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      throw invalidOrigin()
    }
  })

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(securityHeaders)) {
      reply.header(name, value)
    }

    if (config.runtimeMode === 'production') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains')
    }

    if (request.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store')
    }

    return payload
  })
}
