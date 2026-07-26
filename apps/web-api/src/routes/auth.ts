import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify'

import type { AppConfig } from '../config.js'
import { sessionRotationConflict, unauthorized } from '../errors.js'
import type { AuthRateLimiter } from '../auth/rate-limit.js'
import { createLoginRateLimitHook } from '../auth/rate-limit.js'
import { setSessionCookie } from '../auth/auth-context.js'
import type { SessionService } from '../auth/session.js'

type AuthRoutesOptions = {
  config: AppConfig
  sessionService: SessionService
  authRateLimiter: AuthRateLimiter
  authenticate: preHandlerHookHandler
  clearSessionCookie: (reply: FastifyReply, config: AppConfig) => void
}

export const registerAuthRoutes = async (
  app: FastifyInstance,
  options: AuthRoutesOptions,
) => {
  app.get(
    '/api/v1/me',
    {
      preHandler: options.authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['user', 'activeWorkspaceId', 'workspaces'],
            properties: {
              user: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'displayName'],
                properties: {
                  id: { type: 'string' },
                  displayName: { type: 'string' },
                },
              },
              activeWorkspaceId: { type: 'string' },
              workspaces: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['workspaceId', 'workspaceName', 'role'],
                  properties: {
                    workspaceId: { type: 'string' },
                    workspaceName: { type: 'string' },
                    role: { type: 'string', enum: ['owner', 'member'] },
                  },
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
        activeWorkspaceId: session.activeWorkspaceId,
        workspaces: session.memberships,
      }
    },
  )

  app.post(
    '/api/v1/auth/session/rotate',
    {
      preHandler: [
        options.authenticate,
        createLoginRateLimitHook(
          options.authRateLimiter,
          'session',
          'complete',
          (request) => request.authSession?.user.id,
        ),
      ],
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
      preHandler: options.authenticate,
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
