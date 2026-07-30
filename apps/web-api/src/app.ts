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
  type SignupCodeResponseTiming,
  type VerificationEmailSender,
} from './auth/email-auth.js'
import {
  AuthRateLimiter,
  MemoryRateLimitStore,
  UploadAdmissionRateLimiter,
} from './auth/rate-limit.js'
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
import { registerSourceRoutes } from './routes/sources.js'
import { registerDataRoutes, type EngineDataClient } from './routes/data.js'
import { registerTaxReportRoutes } from './routes/tax-reports.js'
import { registerReportPaymentRoutes } from './routes/report-payments.js'
import { registerSecurityPolicy } from './security.js'
import { registerReportAttestationRoutes } from './report-attestations/routes.js'
import { registerSyntheticReportAttestationRoutes } from './report-attestations/synthetic-routes.js'
import { ReportAttestationService } from './report-attestations/service.js'
import {
  MockReportAttestationPublicationSource,
} from './report-attestations/mock-publication-source.js'
import {
  SyntheticTestnetReportAttestationPublicationSource,
} from './report-attestations/synthetic-testnet-publication-source.js'
import type {
  ReportAttestationPublicationSource,
} from './report-attestations/publication-source.js'
import type {
  ReportAttestationRuntime,
  ReportReviewOutcome,
} from './report-attestations/types.js'
import {
  GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND,
  LOCAL_REPORT_ATTESTATION_RUNTIME_KIND,
} from './report-attestations/types.js'
import type {
  ReportAttestationStore,
} from './report-attestations/store.js'
import {
  ReportAttestationWriteRateLimiter,
} from './report-attestations/write-rate-limit.js'
import {
  MemoryWalletSourceStore,
  type WalletSourceStore,
} from './sources/wallet-source-store.js'
import type { TaxReportReader } from './tax-report/types.js'
import { UnavailableWalletSourceStore } from './sources/unavailable-wallet-source-store.js'
import type { ReportPaymentFacilitator } from './report-payment/facilitator.js'
import type { ReportPaymentStore } from './report-payment/types.js'
import type { ReportPaymentTaxReportReader } from './tax-report/types.js'
import type { UploadStore } from './uploads/upload-store.js'
import { registerReportAttestationDeploymentRoutes } from './routes/report-attestation-deployment.js'
import type { ReportAttestationDeploymentReader } from './report-attestation-deployment/reader.js'
import { EthersWalletSignatureVerifier, type WalletSignatureVerifier } from './sources/wallet-signature-verifier.js'

type BuildAppOptions = {
  config?: AppConfig
  logger?: false | FastifyBaseLogger
  sessionStore?: SessionStore
  rateLimitStore?: RateLimitStore
  accountAuthStore?: AccountAuthStore
  oauthAdapters?: ReadonlyArray<OAuthProviderAdapter>
  verificationEmailSender?: VerificationEmailSender
  signupCodeResponseTiming?: SignupCodeResponseTiming
  walletSourceStore?: WalletSourceStore
  uploadStore?: UploadStore
  engineDataClient?: EngineDataClient
  taxReportReader?: TaxReportReader
  reportPaymentTaxReportReader?: ReportPaymentTaxReportReader
  reportPaymentStore?: ReportPaymentStore
  reportPaymentFacilitator?: ReportPaymentFacilitator
  reportAttestations?: {
    runtime: ReportAttestationRuntime
    reviewOutcome: ReportReviewOutcome
    store?: ReportAttestationStore
    identityKey?: Uint8Array
    publicationSource?: ReportAttestationPublicationSource
    localSyntheticFixture?: boolean
  }
  reportAttestationDeploymentReader?: ReportAttestationDeploymentReader
  walletSignatureVerifier?: WalletSignatureVerifier
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
  const localSyntheticFixture =
    options.reportAttestations?.localSyntheticFixture === true
  if (
    config.runtimeMode === 'production' &&
    options.reportAttestations?.runtime.kind ===
      LOCAL_REPORT_ATTESTATION_RUNTIME_KIND
  ) {
    throw new Error(
      'Local report attestations are not allowed in production',
    )
  }
  if (localSyntheticFixture) {
    const publicOriginHost = new URL(
      config.publicOrigin,
    ).hostname.toLowerCase()
    const loopbackHosts = new Set([
      '127.0.0.1',
      'localhost',
      '::1',
      '[::1]',
    ])
    if (
      config.runtimeMode !== 'development' ||
      !loopbackHosts.has(config.host.toLowerCase()) ||
      !loopbackHosts.has(publicOriginHost) ||
      options.reportAttestations?.runtime.kind !==
        LOCAL_REPORT_ATTESTATION_RUNTIME_KIND
    ) {
      throw new Error(
        'The local synthetic report fixture requires a loopback development server and the local Anvil runtime',
      )
    }
  }
  if (
    config.runtimeMode === 'production' &&
    options.reportAttestations &&
    options.reportAttestations.store?.durable !== true
  ) {
    throw new Error(
      'A durable ReportAttestationStore is required in production',
    )
  }
  if (
    config.reportAttestationSyntheticTestnet &&
    !options.reportAttestations
  ) {
    throw new Error(
      'A GIWA Sepolia report attestation runtime is required when the synthetic testnet pilot is enabled',
    )
  }
  if (
    config.reportAttestationSyntheticTestnet &&
    options.reportAttestations?.runtime.kind !==
      GIWA_SEPOLIA_REPORT_ATTESTATION_RUNTIME_KIND
  ) {
    throw new Error(
      'The synthetic testnet pilot requires the GIWA Sepolia report attestation runtime',
    )
  }
  if (config.runtimeMode === 'production' && options.sessionStore?.durable !== true) {
    throw new Error('A durable SessionStore is required in production')
  }
  if (config.runtimeMode === 'production' && options.rateLimitStore?.durable !== true) {
    throw new Error('A durable RateLimitStore is required in production')
  }
  if (config.runtimeMode === 'production' && options.walletSourceStore?.durable !== true) {
    throw new Error('A durable WalletSourceStore is required in production')
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
    (!options.reportPaymentTaxReportReader ||
      !options.reportPaymentStore ||
      !options.reportPaymentFacilitator)
  ) {
    throw new Error(
      'ReportPaymentTaxReportReader, ReportPaymentStore and ReportPaymentFacilitator are required when report payments are enabled',
    )
  }
  if (
    config.reportAttestationDeployment &&
    !options.reportAttestationDeploymentReader
  ) {
    throw new Error(
      'A ReportAttestationDeploymentReader is required when GIWA report attestations are enabled',
    )
  }
  const signupMethodsMatchAuthConfiguration =
    (!config.signup.methods.email || config.emailAuth.enabled) &&
    config.signup.methods.oauthProviders.every((provider) =>
      config.oauth.enabledProviders.has(provider),
    )
  const identityRequirementMatchesConfiguration =
    !config.signup.enabled ||
    config.signup.identityVerificationRequired ===
      (config.identityVerificationMode !== 'disabled')
  if (
    !signupMethodsMatchAuthConfiguration ||
    !identityRequirementMatchesConfiguration ||
    (!config.signup.enabled &&
      (config.signup.methods.email ||
        config.signup.methods.oauthProviders.length > 0)) ||
    (config.signup.enabled &&
      !config.signup.methods.email &&
      config.signup.methods.oauthProviders.length === 0)
  ) {
    throw new Error(
      'Signup capability must match configured authentication methods and identity verification mode',
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
  const rateLimitStore = options.rateLimitStore ?? new MemoryRateLimitStore()
  const authRateLimiter = new AuthRateLimiter(
    rateLimitStore,
    config.rateLimitHmacSecret,
    options.now,
  )
  const uploadAdmissionRateLimiter = new UploadAdmissionRateLimiter(
    rateLimitStore,
    config.rateLimitHmacSecret,
    options.now,
  )
  const reportAttestationWriteRateLimiter =
    config.reportAttestationSyntheticTestnet
      ? new ReportAttestationWriteRateLimiter(
          rateLimitStore,
          config.rateLimitHmacSecret,
          config.reportAttestationSyntheticTestnet.dailyWriteLimits,
          options.now,
        )
      : undefined
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
      verificationDeliveryFailed: ({ challengeId, error }) => {
        app.log.error(
          {
            challengeId,
            errorClass: error instanceof Error ? 'error' : 'non_error',
          },
          'email challenge delivery failed',
        )
      },
    },
    options.signupCodeResponseTiming,
  )
  const walletSourceStore = options.walletSourceStore ?? (
    config.databaseUrl
      ? new UnavailableWalletSourceStore()
      : new MemoryWalletSourceStore()
  )
  const walletSignatureVerifier = options.walletSignatureVerifier ??
    new EthersWalletSignatureVerifier(config.walletSignatureRpcUrls ?? new Map())
  if (options.reportAttestations?.store?.recoverInterrupted) {
    await options.reportAttestations.store.recoverInterrupted()
  }
  const reportAttestationService = options.reportAttestations
    ? new ReportAttestationService({
        runtime: options.reportAttestations.runtime,
        reviewOutcome: options.reportAttestations.reviewOutcome,
        ...(options.reportAttestations.store
          ? { store: options.reportAttestations.store }
          : {}),
        ...(options.reportAttestations.identityKey
          ? { identityKey: options.reportAttestations.identityKey }
          : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    : undefined

  if (reportAttestationService) {
    app.addHook('onClose', async () => {
      await reportAttestationService.close()
    })
  }

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

  await app.register(async (protectedApp) => {
    protectedApp.addHook('onRequest', authHooks.authenticate)

    await registerAuthRoutes(protectedApp, {
      config,
      sessionService,
      authRateLimiter,
      clearSessionCookie: authHooks.clearSessionCookie,
    })
    await registerSourceRoutes(protectedApp, {
      config,
      walletSourceStore,
      walletSignatureVerifier,
      authRateLimiter,
      ...(options.engineDataClient ? { engineDataClient: options.engineDataClient } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    await registerDataRoutes(protectedApp, {
      uploadAdmissionRateLimiter,
      upbitPdfImportEnabled: config.upbitPdfImportEnabled,
      ...(options.uploadStore ? { uploadStore: options.uploadStore } : {}),
      ...(options.engineDataClient ? { engine: options.engineDataClient } : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    if (options.taxReportReader) {
      await registerTaxReportRoutes(protectedApp, {
        reader: options.taxReportReader,
      })
    }
    await registerReportPaymentRoutes(protectedApp, {
      config,
      ...(config.reportPayments
        ? { paymentConfig: config.reportPayments }
        : {}),
      ...(options.reportPaymentTaxReportReader
        ? { reader: options.reportPaymentTaxReportReader }
        : {}),
      ...(options.reportPaymentStore ? { store: options.reportPaymentStore } : {}),
      ...(options.reportPaymentFacilitator
        ? { facilitator: options.reportPaymentFacilitator }
        : {}),
      ...(options.now ? { now: options.now } : {}),
    })
    await registerReportAttestationDeploymentRoutes(protectedApp, {
      ...(config.reportAttestationDeployment
        ? { config: config.reportAttestationDeployment }
        : {}),
      ...(options.reportAttestationDeploymentReader
        ? { reader: options.reportAttestationDeploymentReader }
        : {}),
    })
    await registerSyntheticReportAttestationRoutes(protectedApp, {
      enabled: Boolean(
        (config.reportAttestationSyntheticTestnet ||
          localSyntheticFixture) &&
          reportAttestationService,
      ),
      disabledReasonCode: config.reportAttestationDeployment
        ? 'WRITER_NOT_CONFIGURED'
        : 'DEPLOYMENT_NOT_CONFIGURED',
      capability: localSyntheticFixture
        ? {
            network: 'eip155:31337',
            mode: 'LOCAL_ANVIL',
            explorerBaseUrl: null,
          }
        : {
            network: 'eip155:91342',
            mode: 'SYNTHETIC_TESTNET',
            explorerBaseUrl:
              config.reportAttestationSyntheticTestnet?.explorerBaseUrl ??
              'https://sepolia-explorer.giwa.io',
          },
      ...(reportAttestationService
        ? { service: reportAttestationService }
        : {}),
      ...(config.reportAttestationSyntheticTestnet ||
      localSyntheticFixture
        ? {
            publicationSource:
              options.reportAttestations?.publicationSource ??
              (localSyntheticFixture
                ? new MockReportAttestationPublicationSource()
                : new SyntheticTestnetReportAttestationPublicationSource()),
          }
        : {}),
      ...(reportAttestationWriteRateLimiter
        ? { writeRateLimiter: reportAttestationWriteRateLimiter }
        : {}),
    })
    if (
      reportAttestationService &&
      options.reportAttestations?.runtime.kind ===
        LOCAL_REPORT_ATTESTATION_RUNTIME_KIND
    ) {
      await registerReportAttestationRoutes(protectedApp, {
        service: reportAttestationService,
        publicationSource:
          options.reportAttestations?.publicationSource ??
          new MockReportAttestationPublicationSource(),
      })
    }
  })
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
    reportAttestationService,
  }
}
