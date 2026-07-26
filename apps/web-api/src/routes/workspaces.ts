import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { resourceNotFound, unauthorized } from '../errors.js'

type WorkspaceRoutesOptions = {
  authenticate: preHandlerHookHandler
  requireWorkspace: () => preHandlerHookHandler
}

type WorkspaceParams = {
  workspaceId: string
}

export const registerWorkspaceRoutes = async (
  app: FastifyInstance,
  options: WorkspaceRoutesOptions,
) => {
  app.get<{ Params: WorkspaceParams }>(
    '/api/v1/workspaces/:workspaceId',
    {
      preHandler: [options.authenticate, options.requireWorkspace()],
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['workspaceId'],
          properties: {
            workspaceId: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['workspace'],
            properties: {
              workspace: {
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
    async (request) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }

      const membership = session.memberships.find(
        ({ workspaceId }) => workspaceId === request.params.workspaceId,
      )
      if (!membership) {
        throw resourceNotFound()
      }

      return { workspace: membership }
    },
  )
}
