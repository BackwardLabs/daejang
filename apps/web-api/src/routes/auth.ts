import type { FastifyInstance, FastifyReply } from 'fastify'

import type { AppConfig } from '../config.js'
import { ApiError, resourceNotFound, sessionRotationConflict, unauthorized } from '../errors.js'
import type { AccountAuthStore } from '../auth/account-auth-store.js'
import type { AuthRateLimiter } from '../auth/rate-limit.js'
import { createLoginRateLimitHook } from '../auth/rate-limit.js'
import { setSessionCookie } from '../auth/auth-context.js'
import type { SessionService } from '../auth/session.js'

type AuthRoutesOptions = {
  config: AppConfig
  sessionService: SessionService
  accountStore: AccountAuthStore
  authRateLimiter: AuthRateLimiter
  clearSessionCookie: (reply: FastifyReply, config: AppConfig) => void
}

export const registerAuthRoutes = async (
  app: FastifyInstance,
  options: AuthRoutesOptions,
) => {
  app.get(
    '/api/v1/me',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['user'],
            properties: {
              user: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'displayName'],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  displayName: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }

      return {
        user: session.user,
      }
    },
  )

  app.patch<{ Body: { displayName: string } }>(
    '/api/v1/me',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['displayName'],
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: 80 },
          },
        },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) throw unauthorized()
      const displayName = request.body.displayName
        .normalize('NFC')
        .trim()
        .replace(/\s+/gu, ' ')
      const length = [...displayName].length
      if (length < 2 || length > 20 || /[\p{Cc}\p{Cf}]/u.test(displayName)) {
        throw new ApiError(
          400,
          'INVALID_DISPLAY_NAME',
          '닉네임은 제어문자 없이 2자 이상 20자 이하로 입력해 주세요.',
        )
      }
      const updated = await options.accountStore.updateUserDisplayName(
        session.user.id,
        displayName,
      )
      if (!updated) throw resourceNotFound()
      session.user.displayName = updated.displayName
      return { user: session.user }
    },
  )

  app.post(
    '/api/v1/auth/session/rotate',
    {
      preHandler: createLoginRateLimitHook(
        options.authRateLimiter,
        'session',
        'complete',
        (request) => request.authSession?.user.id,
      ),
      schema: {
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      const token = request.sessionToken
      if (!token) {
        throw unauthorized()
      }

      const rotated = await options.sessionService.rotate(token)
      if (!rotated) {
        throw sessionRotationConflict()
      }

      setSessionCookie(
        reply,
        rotated.token,
        rotated.session.absoluteExpiresAt,
        options.config,
      )
      return reply.status(204).send()
    },
  )

  app.post(
    '/api/v1/auth/logout',
    {
      schema: {
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      if (request.sessionToken) {
        await options.sessionService.revoke(request.sessionToken)
      }

      options.clearSessionCookie(reply, options.config)
      return reply.status(204).send()
    },
  )
}
