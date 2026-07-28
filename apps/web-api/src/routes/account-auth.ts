import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

import type {
  FastifyInstance,
  FastifyReply,
  preHandlerHookHandler,
} from 'fastify'

import {
  clearOAuthTransactionCookie,
  clearSignupSessionCookie,
  oauthTransactionCookieName,
  setOAuthTransactionCookie,
  setSessionCookie,
  setSignupSessionCookie,
} from '../auth/auth-context.js'
import type {
  AccountAuthStore,
  AccountUser,
  LegalDocumentType,
  OAuthIntent,
} from '../auth/account-auth-store.js'
import type { EmailAuthService } from '../auth/email-auth.js'
import type { LoginCompletionService } from '../auth/login-completion.js'
import type { OAuthService } from '../auth/oauth.js'
import { normalizeReturnPath } from '../auth/oauth.js'
import type { AuthRateLimiter } from '../auth/rate-limit.js'
import { createLoginRateLimitHook } from '../auth/rate-limit.js'
import type { SignupSessionService } from '../auth/signup-session.js'
import type { SessionService } from '../auth/session.js'
import type { AppConfig, OAuthProviderName } from '../config.js'
import { ApiError } from '../errors.js'
import {
  accountAlreadyExists,
  accountUnavailable,
  identityVerificationUnavailable,
  invalidOAuthTransaction,
  legalDocumentsUnavailable,
  oauthAccountNotFound,
  oauthProviderUnavailable,
  signupAuthenticationRequired,
  signupUnavailable,
} from '../errors.js'

type AccountAuthRoutesOptions = {
  config: AppConfig
  accountStore: AccountAuthStore
  oauthService: OAuthService
  emailAuthService: EmailAuthService
  loginCompletionService: LoginCompletionService
  signupSessionService: SignupSessionService
  sessionService: SessionService
  authRateLimiter: AuthRateLimiter
  authenticateSignup: preHandlerHookHandler
  now?: () => Date
}

const oauthProviders = new Set<OAuthProviderName>([
  'naver',
  'google',
  'kakao',
])
const oauthIntents = new Set<OAuthIntent>(['signup', 'login'])
const requiredLegalDocumentTypes = new Set<LegalDocumentType>([
  'terms',
  'privacy',
  'identity_verification',
])
const currentTime = (options: AccountAuthRoutesOptions) =>
  options.now?.() ?? new Date()

const assertSignupEnabled = (options: AccountAuthRoutesOptions) => {
  if (!options.config.signup.enabled) {
    throw signupUnavailable()
  }
}

const hasMatchingContentHash = (content: string, expectedHash: string) =>
  createHash('sha256').update(content, 'utf8').digest('hex') === expectedHash

const hasMatchingOAuthBrowserState = (
  browserState: string | undefined,
  callbackState: string,
) => {
  if (!browserState) {
    return false
  }
  const browserBuffer = Buffer.from(browserState, 'utf8')
  const callbackBuffer = Buffer.from(callbackState, 'utf8')
  return (
    browserBuffer.length === callbackBuffer.length &&
    timingSafeEqual(browserBuffer, callbackBuffer)
  )
}

const parseProvider = (value: string) => {
  if (!oauthProviders.has(value as OAuthProviderName)) {
    throw oauthProviderUnavailable()
  }
  return value as OAuthProviderName
}

const safeCallbackErrorCode = (error: unknown) =>
  error instanceof ApiError
    ? error.code.toLocaleLowerCase('en-US')
    : 'oauth_callback_failed'

const setSignupCookieForUser = async (
  reply: FastifyReply,
  user: AccountUser,
  options: AccountAuthRoutesOptions,
) => {
  const signupSession = await options.signupSessionService.create(user.id)
  setSignupSessionCookie(
    reply,
    signupSession.token,
    signupSession.expiresAt,
    options.config,
  )
}

const completeActiveLogin = async (
  reply: FastifyReply,
  input: {
    provider: 'oauth' | 'email'
    providerIdentity: string
    ip: string
    user: AccountUser
    currentSessionToken: string | undefined
  },
  options: AccountAuthRoutesOptions,
) => {
  const completed = await options.loginCompletionService.complete({
    provider: input.provider,
    ip: input.ip,
    providerIdentity: input.providerIdentity,
    currentSessionToken: input.currentSessionToken,
    verifyProvider: async () => ({
      user: {
        id: input.user.id,
        displayName: input.user.displayName,
      },
    }),
  })
  setSessionCookie(
    reply,
    completed.token,
    completed.session.absoluteExpiresAt,
    options.config,
  )
  clearSignupSessionCookie(reply, options.config)
}

export const registerAccountAuthRoutes = async (
  app: FastifyInstance,
  options: AccountAuthRoutesOptions,
) => {
  app.get('/api/v1/auth/capabilities', async () => ({
    signup: {
      enabled: options.config.signup.enabled,
      methods: {
        email: options.config.signup.methods.email,
        oauthProviders: [...options.config.signup.methods.oauthProviders],
      },
    },
  }))

  app.get<{
    Params: { provider: string }
    Querystring: {
      intent: string
      return_to?: string
    }
  }>(
    '/api/v1/auth/oauth/:provider/start',
    {
      preHandler: [
        async (request) => {
          if (request.query.intent === 'signup') {
            assertSignupEnabled(options)
          }
        },
        createLoginRateLimitHook(
          options.authRateLimiter,
          'oauth',
          'begin',
        ),
      ],
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['provider'],
          properties: { provider: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['intent'],
          properties: {
            intent: { type: 'string', enum: ['signup', 'login'] },
            return_to: { type: 'string', maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const provider = parseProvider(request.params.provider)
      if (!oauthIntents.has(request.query.intent as OAuthIntent)) {
        throw oauthProviderUnavailable()
      }
      if (request.query.intent === 'signup') {
        assertSignupEnabled(options)
      }
      const authorizationUrl = await options.oauthService.start({
        provider,
        intent: request.query.intent as OAuthIntent,
        returnPath: request.query.return_to,
      })
      const state = authorizationUrl.searchParams.get('state')
      if (!state) {
        throw invalidOAuthTransaction()
      }
      setOAuthTransactionCookie(
        reply,
        state,
        new Date(
          currentTime(options).getTime() +
            options.config.oauth.transactionTtlSeconds * 1_000,
        ),
        options.config,
      )
      return reply.redirect(authorizationUrl.toString(), 302)
    },
  )

  app.get<{
    Params: { provider: string }
    Querystring: {
      code?: string
      state: string
      error?: string
      error_description?: string
    }
  }>(
    '/api/v1/auth/oauth/:provider/callback',
    {
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          required: ['provider'],
          properties: { provider: { type: 'string' } },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['state'],
          oneOf: [{ required: ['code'] }, { required: ['error'] }],
          properties: {
            code: { type: 'string', minLength: 1, maxLength: 4096 },
            state: { type: 'string', minLength: 20, maxLength: 512 },
            error: { type: 'string', minLength: 1, maxLength: 256 },
            error_description: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const browserState =
          request.cookies[oauthTransactionCookieName(options.config)]
        if (
          !hasMatchingOAuthBrowserState(browserState, request.query.state)
        ) {
          throw invalidOAuthTransaction()
        }
        clearOAuthTransactionCookie(reply, options.config)

        const provider = parseProvider(request.params.provider)
        if (request.query.error) {
          await options.oauthService.cancel({
            provider,
            state: request.query.state,
          })
          const deniedDestination = new URL(
            '/login',
            options.config.publicOrigin,
          )
          deniedDestination.searchParams.set(
            'auth_error',
            'oauth_access_denied',
          )
          return reply.redirect(
            `${deniedDestination.pathname}${deniedDestination.search}`,
            302,
          )
        }
        if (!request.query.code) {
          throw oauthProviderUnavailable()
        }
        const completed = await options.oauthService.complete({
          provider,
          code: request.query.code,
          state: request.query.state,
        })
        if (completed.transaction.intent === 'signup') {
          assertSignupEnabled(options)
        }
        let user = await options.accountStore.findUserByIdentity(
          provider,
          completed.identity.providerSubject,
        )

        if (completed.transaction.intent === 'login') {
          if (!user) {
            throw oauthAccountNotFound()
          }
          if (user.status === 'pending') {
            assertSignupEnabled(options)
            await setSignupCookieForUser(reply, user, options)
            return reply.redirect('/?onboarding=terms', 302)
          }
          if (user.status !== 'active') {
            throw accountUnavailable()
          }
          await completeActiveLogin(
            reply,
            {
              provider: 'oauth',
              providerIdentity: `${provider}:${completed.identity.providerSubject}`,
              ip: request.ip,
              user,
              currentSessionToken:
                request.cookies[options.config.sessionCookieName],
            },
            options,
          )
          return reply.redirect(
            normalizeReturnPath(completed.transaction.returnPath),
            302,
          )
        }

        if (user?.status === 'active') {
          throw accountAlreadyExists()
        }
        if (user && user.status !== 'pending') {
          throw accountUnavailable()
        }
        user ??= await options.accountStore.createPendingOAuthUser({
          userId: randomUUID(),
          identityId: randomUUID(),
          provider,
          providerSubject: completed.identity.providerSubject,
          verifiedAt: currentTime(options),
          email: completed.identity.email,
          emailVerified: completed.identity.emailVerified,
        })
        await setSignupCookieForUser(reply, user, options)
        return reply.redirect('/?onboarding=terms', 302)
      } catch (error) {
        request.log.warn(
          {
            provider: request.params.provider,
            errorCode: safeCallbackErrorCode(error),
          },
          'oauth callback rejected',
        )
        const destination = new URL('/login', options.config.publicOrigin)
        destination.searchParams.set('auth_error', safeCallbackErrorCode(error))
        return reply.redirect(`${destination.pathname}${destination.search}`, 302)
      }
    },
  )

  app.post<{
    Body: { email: string; intent: 'signup' }
  }>(
    '/api/v1/auth/email/send-code',
    {
      preHandler: [
        async () => assertSignupEnabled(options),
        createLoginRateLimitHook(
          options.authRateLimiter,
          'email',
          'begin',
          (request) => {
            const body = request.body as { email?: unknown } | undefined
            return typeof body?.email === 'string' ? body.email : undefined
          },
        ),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'intent'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            intent: { type: 'string', const: 'signup' },
          },
        },
      },
    },
    async (request, reply) => {
      assertSignupEnabled(options)
      if (!options.config.emailAuth.enabled) {
        throw oauthProviderUnavailable()
      }
      const result = await options.emailAuthService.sendSignupCode(
        request.body.email,
      )
      return reply.status(202).send({ status: 'accepted', ...result })
    },
  )

  app.post<{
    Body: { email: string; intent: 'signup'; code: string }
  }>(
    '/api/v1/auth/email/verify-code',
    {
      preHandler: [
        async () => assertSignupEnabled(options),
        createLoginRateLimitHook(
          options.authRateLimiter,
          'email',
          'complete',
          (request) => {
            const body = request.body as { email?: unknown } | undefined
            return typeof body?.email === 'string' ? body.email : undefined
          },
        ),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'intent', 'code'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            intent: { type: 'string', const: 'signup' },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
        },
      },
    },
    async (request) => {
      assertSignupEnabled(options)
      return options.emailAuthService.verifySignupCode(
        request.body.email,
        request.body.code,
      )
    },
  )

  app.post<{
    Body: {
      email: string
      password: string
      passwordConfirmation: string
      verificationToken: string
    }
  }>(
    '/api/v1/auth/email/signup',
    {
      preHandler: [
        async () => assertSignupEnabled(options),
        createLoginRateLimitHook(
          options.authRateLimiter,
          'email',
          'complete',
          (request) => {
            const body = request.body as { email?: unknown } | undefined
            return typeof body?.email === 'string' ? body.email : undefined
          },
        ),
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'email',
            'password',
            'passwordConfirmation',
            'verificationToken',
          ],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 8, maxLength: 128 },
            passwordConfirmation: {
              type: 'string',
              minLength: 8,
              maxLength: 128,
            },
            verificationToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
            },
          },
        },
      },
    },
    async (request, reply) => {
      assertSignupEnabled(options)
      const user = await options.emailAuthService.signup({
        rawEmail: request.body.email,
        password: request.body.password,
        passwordConfirmation: request.body.passwordConfirmation,
        verificationToken: request.body.verificationToken,
      })
      await setSignupCookieForUser(reply, user, options)
      return reply.status(201).send({
        status: 'signup_pending',
        nextStep: 'terms',
      })
    },
  )

  app.post<{
    Body: { email: string; password: string; returnTo?: string }
  }>(
    '/api/v1/auth/email/login',
    {
      preHandler: createLoginRateLimitHook(
        options.authRateLimiter,
        'email',
        'begin',
        (request) => {
          const body = request.body as { email?: unknown } | undefined
          return typeof body?.email === 'string' ? body.email : undefined
        },
      ),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', minLength: 3, maxLength: 320 },
            password: { type: 'string', minLength: 1, maxLength: 128 },
            returnTo: { type: 'string', maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const user = await options.emailAuthService.authenticate(
        request.body.email,
        request.body.password,
      )
      if (user.status === 'pending') {
        assertSignupEnabled(options)
        await setSignupCookieForUser(reply, user, options)
        return {
          status: 'signup_pending',
          nextPath: '/?onboarding=terms',
        }
      }
      if (user.status !== 'active') {
        throw accountUnavailable()
      }
      await completeActiveLogin(
        reply,
        {
          provider: 'email',
          providerIdentity: request.body.email,
          ip: request.ip,
          user,
          currentSessionToken:
            request.cookies[options.config.sessionCookieName],
        },
        options,
      )
      return {
        status: 'authenticated',
        nextPath: normalizeReturnPath(request.body.returnTo),
      }
    },
  )

  app.get<{ Querystring: { locale?: string } }>(
    '/api/v1/legal-documents/current',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            locale: {
              type: 'string',
              const: 'ko-KR',
              default: 'ko-KR',
            },
          },
        },
      },
    },
    async (request) => {
      const documents = await options.accountStore.listCurrentLegalDocuments(
        request.query.locale ?? 'ko-KR',
        currentTime(options),
      )
      const availableTypes = new Set(
        documents.map((document) => document.documentType),
      )
      if (
        [...requiredLegalDocumentTypes].some(
          (documentType) => !availableTypes.has(documentType),
        ) ||
        documents.some(
          (document) =>
            !hasMatchingContentHash(document.content, document.contentHash),
        )
      ) {
        throw legalDocumentsUnavailable()
      }
      return {
        documents: documents.map((document) => ({
          ...document,
          required: requiredLegalDocumentTypes.has(document.documentType),
        })),
      }
    },
  )

  app.post<{
    Body: {
      locale: string
      decisions: Array<{
        legalDocumentId: string
        action: 'accepted' | 'withdrawn'
      }>
    }
  }>(
    '/api/v1/signup/consents',
    {
      preHandler: [
        async () => assertSignupEnabled(options),
        options.authenticateSignup,
      ],
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['locale', 'decisions'],
          properties: {
            locale: { type: 'string', const: 'ko-KR' },
            decisions: {
              type: 'array',
              minItems: 3,
              maxItems: 4,
              uniqueItems: true,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['legalDocumentId', 'action'],
                properties: {
                  legalDocumentId: { type: 'string', format: 'uuid' },
                  action: {
                    type: 'string',
                    enum: ['accepted', 'withdrawn'],
                  },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const user = request.signupUser
      if (!user) {
        throw signupAuthenticationRequired()
      }
      await options.accountStore.recordSignupConsents({
        userId: user.id,
        locale: request.body.locale,
        decisions: request.body.decisions.map((decision) => ({
          id: randomUUID(),
          legalDocumentId: decision.legalDocumentId,
          action: decision.action,
        })),
        now: currentTime(options),
      })
      return {
        status: 'accepted',
        nextStep: 'identity_verification',
      }
    },
  )

  app.post(
    '/api/v1/signup/identity-verification/mock-complete',
    {
      preHandler: [
        async () => assertSignupEnabled(options),
        options.authenticateSignup,
      ],
    },
    async (request, reply) => {
      if (options.config.identityVerificationMode !== 'mock') {
        throw identityVerificationUnavailable()
      }
      const user = request.signupUser
      const signupToken = request.signupSessionToken
      if (!user || !signupToken) {
        throw signupAuthenticationRequired()
      }
      const activatedUser = await options.signupSessionService.complete(
        signupToken,
        user.id,
      )
      if (!activatedUser) {
        throw signupAuthenticationRequired()
      }
      const session = await options.sessionService.create({
        user: {
          id: activatedUser.id,
          displayName: activatedUser.displayName,
        },
      })
      setSessionCookie(
        reply,
        session.token,
        session.session.absoluteExpiresAt,
        options.config,
      )
      clearSignupSessionCookie(reply, options.config)
      return {
        status: 'authenticated',
        nextPath: '/dashboard',
      }
    },
  )

  app.post(
    '/api/v1/signup/cancel',
    { preHandler: options.authenticateSignup },
    async (request, reply) => {
      if (request.signupSessionToken) {
        await options.signupSessionService.revoke(request.signupSessionToken)
      }
      clearSignupSessionCookie(reply, options.config)
      return reply.status(204).send()
    },
  )
}
