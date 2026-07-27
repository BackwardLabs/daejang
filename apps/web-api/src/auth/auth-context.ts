import type { FastifyReply, preHandlerHookHandler } from 'fastify'

import type { AppConfig } from '../config.js'
import { unauthorized } from '../errors.js'
import { signupAuthenticationRequired } from '../errors.js'
import type { AccountUser } from './account-auth-store.js'
import type { SessionRecord, SessionService } from './session.js'
import type { SignupSessionService } from './signup-session.js'

declare module 'fastify' {
  interface FastifyRequest {
    authSession: SessionRecord | undefined
    sessionToken: string | undefined
    signupUser: AccountUser | undefined
    signupSessionToken: string | undefined
  }
}

const sessionCookieOptions = (config: AppConfig) => ({
  path: '/',
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: 'lax',
} as const)

export const oauthTransactionCookieName = (config: AppConfig) =>
  config.runtimeMode === 'production'
    ? '__Host-daejang_oauth'
    : 'daejang_oauth'

export const setOAuthTransactionCookie = (
  reply: FastifyReply,
  state: string,
  expiresAt: Date,
  config: AppConfig,
) => {
  reply.setCookie(oauthTransactionCookieName(config), state, {
    ...sessionCookieOptions(config),
    expires: expiresAt,
  })
}

export const clearOAuthTransactionCookie = (
  reply: FastifyReply,
  config: AppConfig,
) => {
  reply.clearCookie(
    oauthTransactionCookieName(config),
    sessionCookieOptions(config),
  )
}

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

export const setSignupSessionCookie = (
  reply: FastifyReply,
  token: string,
  expiresAt: Date,
  config: AppConfig,
) => {
  reply.setCookie(config.signupSessionCookieName, token, {
    ...sessionCookieOptions(config),
    expires: expiresAt,
  })
}

export const clearSignupSessionCookie = (
  reply: FastifyReply,
  config: AppConfig,
) => {
  reply.clearCookie(config.signupSessionCookieName, sessionCookieOptions(config))
}

export const createAuthHooks = (
  sessionService: SessionService,
  signupSessionService: SignupSessionService,
  config: AppConfig,
) => {
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

  const authenticateSignup: preHandlerHookHandler = async (request, reply) => {
    const token = request.cookies[config.signupSessionCookieName]
    if (!token) {
      throw signupAuthenticationRequired()
    }

    const user = await signupSessionService.resolve(token)
    if (!user) {
      clearSignupSessionCookie(reply, config)
      throw signupAuthenticationRequired()
    }

    request.signupUser = user
    request.signupSessionToken = token
  }

  return {
    authenticate,
    authenticateSignup,
    clearSessionCookie,
    clearSignupSessionCookie,
  }
}
