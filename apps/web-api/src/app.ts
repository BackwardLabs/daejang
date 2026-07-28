import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import type { FastifyBaseLogger } from 'fastify'

import { createAuthHooks } from './auth/auth-context.js'
import {
  MemoryAccountAuthStore,
  type AccountAuthStore,
} from './auth/account-auth-store.js'
import {
  DisabledVerificationEmailSender,
  EmailAuthService,
  type VerificationEmailSender,
} from './auth/email-auth.js'
import { AuthRateLimiter, MemoryRateLimitStore } from './auth/rate-limit.js'
import type { RateLimitStore } from './auth/rate-limit.js'
import { LoginCompletionService } from './auth/login-completion.js'
import { OAuthService, type OAuthProviderAdapter } from './auth/oauth.js'
import {
  GoogleOidcAdapter,
  KakaoOidcAdapter,
  NaverOAuthAdapter,
} from './auth/oauth-providers.js'
import { MemorySessionStore, SessionService } from './auth/session.js'
import type { SessionStore } from './auth/session.js'
import { SignupSessionService } from './auth/signup-session.js'
import { loadConfig } from './config.js'
import type { AppConfig } from './config.js'
import { ApiError } from './errors.js'
import { EngineRpcError } from './engine/rpc-error.js'
import { status as grpcStatus } from '@grpc/grpc-js'
import { createLogger } from './logger.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerAccountAuthRoutes } from './routes/account-auth.js'
import {
  registerDevelopmentRoutes,
  type DevelopmentUserStore,
} from './routes/development.js'
import { registerSourceRoutes } from './routes/sources.js'
import { registerDataRoutes, type EngineDataClient } from './routes/data.js'
import { registerTaxReportRoutes } from './routes/tax-reports.js'
import { registerReportPaymentRoutes } from './routes/report-payments.js'
import { registerSecurityPolicy } from './security.js'
import {
  MemoryWalletSourceStore,
  type WalletSourceStore,
} from './sources/wallet-source-store.js'
import type { TaxReportReader } from './tax-report/types.js'
import type { ReportPaymentFacilitator } from './report-payment/facilitator.js'
import type { ReportPaymentStore } from './report-payment/types.js'
import type { UploadStore } from './uploads/upload-store.js'

type BuildAppOptions = {
  config?: AppConfig
  logger?: false | FastifyBaseLogger
  sessionStore?: SessionStore
  rateLimitStore?: RateLimitStore
  accountAuthStore?: AccountAuthStore
  oauthAdapters?: ReadonlyArray<OAuthProviderAdapter>
  verificationEmailSender?: VerificationEmailSender
  walletSourceStore?: WalletSourceStore
  uploadStore?: UploadStore
  engineDataClient?: EngineDataClient
  developmentUserStore?: DevelopmentUserStore
  taxReportReader?: TaxReportReader
  reportPaymentStore?: ReportPaymentStore
  reportPaymentFacilitator?: ReportPaymentFacilitator
  now?: () => Date
  readinessCheck?: () => Promise<void>
}

const hasValidationErrors = (error: unknown): error is { validation: unknown } =>
  typeof error === 'object' && error !== null && 'validation' in error

const hasStatusCode = (error: unknown): error is { statusCode: number } =>
  typeof error === 'object' &&
  error !== null &&
  'statusCode' in error &&
  typeof error.statusCode === 'number'

export const buildApp = async (options: BuildAppOptions = {}) => {
  const config = options.config ?? loadConfig()
  if (config.runtimeMode === 'production' && options.sessionStore?.durable !== true) {
    throw new Error('A durable SessionStore is required in production')
  }
  if (config.runtimeMode === 'production' && options.rateLimitStore?.durable !== true) {
    throw new Error('A durable RateLimitStore is required in production')
  }
  if (config.runtimeMode === 'production' && options.walletSourceStore?.durable !== true) {
    throw new Error('A durable WalletSourceStore is required in production')
  }
  if (config.devBootstrapUser && !options.developmentUserStore) {
    throw new Error('A DevelopmentUserStore is required for development bootstrap')
  }
  if (
    config.runtimeMode === 'production' &&
    options.accountAuthStore?.durable !== true
  ) {
    throw new Error('A durable AccountAuthStore is required in production')
  }
  if (config.runtimeMode === 'production' && options.taxReportReader?.durable !== true) {
    throw new Error('A durable TaxReportReader is required in production')
  }
  if (
    config.runtimeMode === 'production' &&
    config.reportPayments &&
    options.reportPaymentStore?.durable !== true
  ) {
    throw new Error('A durable ReportPaymentStore is required when report payments are enabled')
  }
  if (
    config.reportPayments &&
    (!options.taxReportReader ||
      !options.reportPaymentStore ||
      !options.reportPaymentFacilitator)
  ) {
    throw new Error(
      'TaxReportReader, ReportPaymentStore and ReportPaymentFacilitator are required when report payments are enabled',
    )
  }
  const signupMethodsMatchAuthConfiguration =
    (!config.signup.methods.email || config.emailAuth.enabled) &&
    config.signup.methods.oauthProviders.every((provider) =>
      config.oauth.enabledProviders.has(provider),
    )
  if (
    !signupMethodsMatchAuthConfiguration ||
    (!config.signup.enabled &&
      (config.signup.methods.email ||
        config.signup.methods.oauthProviders.length > 0)) ||
    (config.signup.enabled &&
      (config.runtimeMode === 'production' ||
        config.identityVerificationMode !== 'mock' ||
        (!config.signup.methods.email &&
          config.signup.methods.oauthProviders.length === 0)))
  ) {
    throw new Error(
      'Signup capability must match configured authentication methods and a completion-capable verifier',
    )
  }

  const app =
    options.logger === false
      ? Fastify({
          logger: false,
          bodyLimit: config.bodyLimitBytes,
          trustProxy: config.trustProxyHops === 0 ? false : config.trustProxyHops,
        })
      : Fastify({
          loggerInstance: options.logger ?? createLogger(),
          bodyLimit: config.bodyLimitBytes,
          trustProxy: config.trustProxyHops === 0 ? false : config.trustProxyHops,
        })
  const sessionStore = options.sessionStore ?? new MemorySessionStore()
  const sessionService = new SessionService(
    sessionStore,
    config.sessionAbsoluteTtlSeconds,
    config.sessionIdleTtlSeconds,
    options.now,
  )
  const authRateLimiter = new AuthRateLimiter(
    options.rateLimitStore ?? new MemoryRateLimitStore(),
    config.rateLimitHmacSecret,
    options.now,
  )
  const loginCompletionService = new LoginCompletionService(authRateLimiter, sessionService)
  const accountAuthStore = options.accountAuthStore ?? new MemoryAccountAuthStore()
  const signupSessionService = new SignupSessionService(
    accountAuthStore,
    config.signupSessionTtlSeconds,
    options.now,
  )
  const oauthService = new OAuthService(
    accountAuthStore,
    config,
    options.oauthAdapters ?? [
      new NaverOAuthAdapter(),
      new GoogleOidcAdapter(),
      new KakaoOidcAdapter(),
    ],
    options.now,
  )
  const emailAuthService = new EmailAuthService(
    accountAuthStore,
    options.verificationEmailSender ??
      new DisabledVerificationEmailSender(),
    config.emailAuth,
    options.now,
    {
      challengeAbandonFailed: ({ challengeId, error }) => {
        app.log.error(
          {
            challengeId,
            errorClass: error instanceof Error ? 'error' : 'non_error',
          },
          'email challenge compensation failed',
        )
      },
    },
  )
  const walletSourceStore = options.walletSourceStore ?? new MemoryWalletSourceStore()

  await app.register(cookie)
  app.decorateRequest('authSession', undefined)
  app.decorateRequest('sessionToken', undefined)
  app.decorateRequest('signupUser', undefined)
  app.decorateRequest('signupSessionToken', undefined)

  const authHooks = createAuthHooks(
    sessionService,
    signupSessionService,
    config,
  )
  await registerSecurityPolicy(app, config)

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.headers(error.headers)
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
          fieldErrors: [],
        },
      })
    }

    if (error instanceof EngineRpcError) {
      const timedOut = error.grpcCode === grpcStatus.DEADLINE_EXCEEDED
      request.log.error({ err: error }, 'engine request failed')
      return reply.status(timedOut ? 504 : 503).send({
        error: {
          code: timedOut ? 'ENGINE_TIMEOUT' : 'ENGINE_UNAVAILABLE',
          message: timedOut
            ? '처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.'
            : '데이터 처리 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
          requestId: request.id,
          fieldErrors: [],
        },
      })
    }

    if (hasValidationErrors(error) && error.validation) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: '요청 값을 확인해 주세요.',
          requestId: request.id,
          fieldErrors: [],
        },
      })
    }

    if (hasStatusCode(error) && error.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'REQUEST_BODY_TOO_LARGE',
          message: '요청 본문이 허용된 크기를 초과했습니다.',
          requestId: request.id,
          fieldErrors: [],
        },
      })
    }

    if (hasStatusCode(error) && error.statusCode === 400) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: '요청 값을 확인해 주세요.',
          requestId: request.id,
          fieldErrors: [],
        },
      })
    }

    request.log.error({ err: error }, 'request failed')
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '요청을 처리하지 못했습니다.',
        requestId: request.id,
        fieldErrors: [],
      },
    })
  })

  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', const: 'ok' } },
          },
        },
      },
    },
    async () => ({ status: 'ok' }),
  )

  app.get('/readyz', async (_request, reply) => {
    try {
      await options.readinessCheck?.()
      return { status: 'ready' }
    } catch {
      return reply.status(503).send({ status: 'not-ready' })
    }
  })

  await registerAuthRoutes(app, {
    config,
    sessionService,
    authRateLimiter,
    authenticate: authHooks.authenticate,
    clearSessionCookie: authHooks.clearSessionCookie,
  })
  await registerAccountAuthRoutes(app, {
    config,
    accountStore: accountAuthStore,
    oauthService,
    emailAuthService,
    loginCompletionService,
    signupSessionService,
    sessionService,
    authRateLimiter,
    authenticateSignup: authHooks.authenticateSignup,
    ...(options.now ? { now: options.now } : {}),
  })
  await registerSourceRoutes(app, {
    config,
    walletSourceStore,
    authRateLimiter,
    authenticate: authHooks.authenticate,
    ...(options.engineDataClient ? { engineDataClient: options.engineDataClient } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  if (options.uploadStore && options.engineDataClient) {
    await registerDataRoutes(app, {
      authenticate: authHooks.authenticate,
      uploadStore: options.uploadStore,
      engine: options.engineDataClient,
      ...(options.now ? { now: options.now } : {}),
    })
  }
  if (options.developmentUserStore) {
    await registerDevelopmentRoutes(app, {
      config,
      sessionService,
      userStore: options.developmentUserStore,
    })
  }
  if (options.taxReportReader) {
    await registerTaxReportRoutes(app, {
      authenticate: authHooks.authenticate,
      reader: options.taxReportReader,
    })
  }
  if (
    options.taxReportReader &&
    config.reportPayments &&
    options.reportPaymentStore &&
    options.reportPaymentFacilitator
  ) {
    await registerReportPaymentRoutes(app, {
      authenticate: authHooks.authenticate,
      config,
      paymentConfig: config.reportPayments,
      reader: options.taxReportReader,
      store: options.reportPaymentStore,
      facilitator: options.reportPaymentFacilitator,
      ...(options.now ? { now: options.now } : {}),
    })
  }
  return {
    app,
    config,
    sessionService,
    signupSessionService,
    loginCompletionService,
    accountAuthStore,
    oauthService,
    emailAuthService,
    walletSourceStore,
  }
}
