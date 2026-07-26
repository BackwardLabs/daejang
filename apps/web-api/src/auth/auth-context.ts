import type { FastifyReply, preHandlerHookHandler } from 'fastify'

import type { AppConfig } from '../config.js'
import { resourceNotFound, unauthorized } from '../errors.js'
import type { SessionRecord, SessionService } from './session.js'

declare module 'fastify' {
  interface FastifyRequest {
    authSession: SessionRecord | undefined
    sessionToken: string | undefined
  }
}

const sessionCookieOptions = (config: AppConfig) => ({
    path: '/',
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
  } as const)

export const setSessionCookie = (
  reply: FastifyReply,
  token: string,
  absoluteExpiresAt: Date,
  config: AppConfig,
) => {
  reply.setCookie(config.sessionCookieName, token, {
    ...sessionCookieOptions(config),
    expires: absoluteExpiresAt,
  })
}

export const clearSessionCookie = (reply: FastifyReply, config: AppConfig) => {
  reply.clearCookie(config.sessionCookieName, sessionCookieOptions(config))
}

export const createAuthHooks = (sessionService: SessionService, config: AppConfig) => {
  const authenticate: preHandlerHookHandler = async (request, reply) => {
    const token = request.cookies[config.sessionCookieName]
    if (!token) {
      throw unauthorized()
    }

    const session = await sessionService.resolve(token)
    if (!session) {
      clearSessionCookie(reply, config)
      throw unauthorized()
    }

    request.authSession = session
    request.sessionToken = token
  }

  const requireWorkspace = (): preHandlerHookHandler => async (request) => {
    const session = request.authSession
    if (!session) {
      throw unauthorized()
    }

    const { workspaceId } = request.params as { workspaceId?: unknown }
    if (
      typeof workspaceId !== 'string' ||
      !session.memberships.some((membership) => membership.workspaceId === workspaceId)
    ) {
      throw resourceNotFound()
    }
  }

  return { authenticate, requireWorkspace, clearSessionCookie }
}
