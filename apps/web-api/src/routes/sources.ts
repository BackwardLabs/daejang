import { randomUUID } from 'node:crypto'

import type { FastifyInstance, preHandlerHookHandler } from 'fastify'
import { verifyMessage } from 'ethers'

import type { AuthRateLimiter } from '../auth/rate-limit.js'
import { createLoginRateLimitHook } from '../auth/rate-limit.js'
import type { AppConfig } from '../config.js'
import {
  invalidWalletChallenge,
  invalidWalletSignature,
  resourceNotFound,
  unauthorized,
} from '../errors.js'
import type {
  WalletOwnershipChallenge,
  WalletSource,
  WalletSourceStore,
} from '../sources/wallet-source-store.js'
import type { EngineDataClient } from './data.js'

type ChallengeBody = {
  address: string
  chainId: string
}

type RegisterWalletBody = {
  challengeId: string
  signature: string
  chainIds: string[]
  label?: string
}

const addressPattern = '^0x[0-9a-fA-F]{40}$'
const chainIdPattern = '^eip155:[1-9][0-9]*$'

const serializeWalletSource = (source: WalletSource) => ({
  id: source.id,
  type: 'EVM_WALLET' as const,
  address: source.address,
  accountType: source.accountType,
  verificationChainId: source.verificationChainId,
  verifiedAt: source.verifiedAt.toISOString(),
  ...(source.label ? { label: source.label } : {}),
  status: source.status,
  createdAt: source.createdAt.toISOString(),
  updatedAt: source.updatedAt.toISOString(),
  ...(source.disconnectedAt
    ? { disconnectedAt: source.disconnectedAt.toISOString() }
    : {}),
  chainScopes: source.chainScopes,
})

const sourceResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'type',
    'address',
    'accountType',
    'verificationChainId',
    'verifiedAt',
    'status',
    'createdAt',
    'updatedAt',
    'chainScopes',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string', const: 'EVM_WALLET' },
    address: { type: 'string', pattern: '^0x[0-9a-f]{40}$' },
    accountType: { type: 'string', const: 'EOA' },
    verificationChainId: { type: 'string', pattern: chainIdPattern },
    verifiedAt: { type: 'string', format: 'date-time' },
    label: { type: 'string' },
    status: { type: 'string', enum: ['ACTIVE', 'DISCONNECTED'] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    disconnectedAt: { type: 'string', format: 'date-time' },
    chainScopes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chainId', 'status'],
        properties: {
          chainId: { type: 'string', pattern: chainIdPattern },
          status: { type: 'string', enum: ['ACTIVE', 'DISABLED'] },
        },
      },
    },
  },
} as const

const documentSourceResponseSchema = {
  type: 'object', additionalProperties: false,
  required: ['id','type','provider','originalFilename','mediaType','byteLength','artifactDigest','coverageStart','coverageEnd','status','createdAt','updatedAt'],
  properties: {
    id: { type: 'string', format: 'uuid' }, type: { type: 'string', const: 'UPBIT_PDF' },
    provider: { type: 'string', const: 'UPBIT' }, originalFilename: { type: 'string' },
    mediaType: { type: 'string', const: 'application/pdf' }, byteLength: { type: 'number' },
    artifactDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    coverageStart: { type: 'string', format: 'date' }, coverageEnd: { type: 'string', format: 'date' },
    status: { type: 'string', enum: ['ACTIVE','DISCONNECTED'] }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
  },
} as const

const createChallengeMessage = (
  config: AppConfig,
  challenge: Pick<
    WalletOwnershipChallenge,
    'id' | 'address' | 'verificationChainId' | 'issuedAt' | 'expiresAt'
  >,
) =>
  [
    'Daejang 지갑 소유권 확인',
    '',
    `도메인: ${new URL(config.publicOrigin).host}`,
    `주소: ${challenge.address}`,
    `체인: ${challenge.verificationChainId}`,
    `Nonce: ${challenge.id}`,
    `발급 시각: ${challenge.issuedAt.toISOString()}`,
    `만료 시각: ${challenge.expiresAt.toISOString()}`,
    '',
    '이 서명은 가스비, 거래 승인 또는 자산 이동을 발생시키지 않습니다.',
  ].join('\n')

export const registerSourceRoutes = async (
  app: FastifyInstance,
  options: {
    config: AppConfig
    walletSourceStore: WalletSourceStore
    authRateLimiter: AuthRateLimiter
    authenticate: preHandlerHookHandler
    engineDataClient?: EngineDataClient
    now?: () => Date
  },
) => {
  const now = options.now ?? (() => new Date())

  app.get(
    '/api/v1/sources',
    {
      preHandler: options.authenticate,
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: { items: { type: 'array', items: { anyOf: [sourceResponseSchema, documentSourceResponseSchema] } } },
          },
        },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const context = {
        requestId: request.id,
        userId: session.user.id,
        sessionId: session.id,
      }
      if (options.engineDataClient) {
        const sources = await options.engineDataClient.listAllSources(context)
        return { items: [...sources.wallets.map((value) => serializeWalletSource(value as WalletSource)), ...sources.documents.map((value) => ({ ...(value as Record<string, unknown>), createdAt: (value as { createdAt: Date }).createdAt.toISOString(), updatedAt: (value as { updatedAt: Date }).updatedAt.toISOString() }))] }
      }
      const sources = await options.walletSourceStore.listWallets(context)
      return { items: sources.map(serializeWalletSource) }
    },
  )

  app.post<{ Body: ChallengeBody }>(
    '/api/v1/sources/wallets/challenges',
    {
      preHandler: [
        options.authenticate,
        createLoginRateLimitHook(
          options.authRateLimiter,
          'siwe',
          'begin',
          (request) => (request.body as ChallengeBody).address,
        ),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['address', 'chainId'],
          properties: {
            address: { type: 'string', pattern: addressPattern },
            chainId: { type: 'string', pattern: chainIdPattern },
          },
        },
        response: {
          201: {
            type: 'object',
            additionalProperties: false,
            required: ['challengeId', 'message', 'expiresAt'],
            properties: {
              challengeId: { type: 'string', format: 'uuid' },
              message: { type: 'string' },
              expiresAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const issuedAt = now()
      const challenge: WalletOwnershipChallenge = {
        id: randomUUID(),
        userId: session.user.id,
        address: request.body.address.toLowerCase(),
        verificationChainId: request.body.chainId,
        message: '',
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 5 * 60 * 1_000),
        consumedAt: undefined,
      }
      challenge.message = createChallengeMessage(options.config, challenge)
      await options.walletSourceStore.createChallenge(challenge)

      return reply.status(201).send({
        challengeId: challenge.id,
        message: challenge.message,
        expiresAt: challenge.expiresAt.toISOString(),
      })
    },
  )

  app.post<{ Body: RegisterWalletBody }>(
    '/api/v1/sources/wallets',
    {
      preHandler: [
        options.authenticate,
        createLoginRateLimitHook(
          options.authRateLimiter,
          'siwe',
          'complete',
          (request) => (request.body as RegisterWalletBody).challengeId,
        ),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['challengeId', 'signature', 'chainIds'],
          properties: {
            challengeId: { type: 'string', format: 'uuid' },
            signature: { type: 'string', minLength: 1, maxLength: 1024 },
            chainIds: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: { type: 'string', pattern: chainIdPattern },
            },
            label: { type: 'string', minLength: 1, maxLength: 120 },
          },
        },
        response: { 201: sourceResponseSchema },
      },
    },
    async (request, reply) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const challenge = await options.walletSourceStore.getChallenge(
        session.user.id,
        request.body.challengeId,
      )
      const currentTime = now()
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= currentTime.getTime()
      ) {
        throw invalidWalletChallenge()
      }

      let recoveredAddress: string
      try {
        recoveredAddress = verifyMessage(challenge.message, request.body.signature).toLowerCase()
      } catch {
        throw invalidWalletSignature()
      }
      if (recoveredAddress !== challenge.address) {
        throw invalidWalletSignature()
      }

      const source = await options.walletSourceStore.completeRegistration({
        challengeId: challenge.id,
        userId: session.user.id,
        recoveredAddress,
        verificationChainId: challenge.verificationChainId,
        chainIds: request.body.chainIds,
        label: request.body.label,
        now: currentTime,
        requestId: request.id,
        sessionId: session.id,
        idempotencyKey: challenge.id,
      })
      if (!source) {
        throw invalidWalletChallenge()
      }
      return reply.status(201).send(serializeWalletSource(source))
    },
  )

  app.post<{ Params: { sourceId: string } }>(
    '/api/v1/sources/:sourceId/disconnect',
    {
      preHandler: options.authenticate,
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceId'],
          properties: { sourceId: { type: 'string', format: 'uuid' } },
        },
        response: { 200: sourceResponseSchema },
      },
    },
    async (request) => {
      const session = request.authSession
      if (!session) {
        throw unauthorized()
      }
      const source = await options.walletSourceStore.disconnectWallet(
        {
          requestId: request.id,
          userId: session.user.id,
          sessionId: session.id,
          idempotencyKey: `disconnect:${request.params.sourceId}`,
        },
        request.params.sourceId,
        now(),
      )
      if (!source) {
        throw resourceNotFound()
      }
      return serializeWalletSource(source)
    },
  )
}
