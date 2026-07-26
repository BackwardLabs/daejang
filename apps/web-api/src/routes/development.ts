import type { FastifyInstance } from 'fastify'

import { setSessionCookie } from '../auth/auth-context.js'
import type { SessionService } from '../auth/session.js'
import type { AppConfig } from '../config.js'

export type DevelopmentUserStore = {
  upsertUser(user: { id: string; displayName: string }): Promise<unknown>
  setStatus(userId: string, status: 'active'): Promise<unknown>
}

export const registerDevelopmentRoutes = async (
  app: FastifyInstance,
  options: {
    config: AppConfig
    sessionService: SessionService
    userStore: DevelopmentUserStore
  },
) => {
  const user = options.config.devBootstrapUser
  if (!user || options.config.runtimeMode !== 'development') {
    return
  }

  app.post(
    '/api/v1/dev/session',
    {
      schema: {
        response: {
          201: {
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
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      await options.userStore.upsertUser(user)
      await options.userStore.setStatus(user.id, 'active')
      const issued = await options.sessionService.create({ user })
      setSessionCookie(
        reply,
        issued.token,
        issued.session.absoluteExpiresAt,
        options.config,
      )
      return reply.status(201).send({ user })
    },
  )
}
