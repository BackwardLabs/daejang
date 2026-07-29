import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildApp } from './app.js'
import {
  MemoryAccountAuthStore,
  type CurrentLegalDocument,
} from './auth/account-auth-store.js'
import type { VerificationEmailSender } from './auth/email-auth.js'
import type {
  NormalizedOAuthIdentity,
  OAuthProviderAdapter,
} from './auth/oauth.js'
import type { AppConfig } from './config.js'

const config: AppConfig = {
  runtimeMode: 'test',
  host: '127.0.0.1',
  port: 3000,
  publicOrigin: 'http://localhost:5173',
  sessionCookieName: 'daejang_session',
  signupSessionCookieName: 'daejang_signup',
  sessionAbsoluteTtlSeconds: 3_600,
  sessionIdleTtlSeconds: 600,
  signupSessionTtlSeconds: 3_600,
  bodyLimitBytes: 1_048_576,
  secureCookies: false,
  trustProxyHops: 0,
  databaseUrl: undefined,
  rateLimitHmacSecret: 'test-rate-limit-secret',
  oauth: {
    enabledProviders: new Set(['naver']),
    transactionTtlSeconds: 600,
    stateHmacSecret: 'test-oauth-state-secret',
    transactionEncryptionKey: Buffer.alloc(32, 1),
    providers: {
      naver: {
        clientId: 'naver-client-id',
        clientSecret: 'naver-client-secret',
      },
    },
  },
  emailAuth: {
    enabled: true,
    resendApiKey: 'test-resend-key',
    from: 'GIWA <test@example.com>',
    verificationHmacSecret: 'test-email-verification-secret',
    verificationTtlSeconds: 300,
    verificationTokenTtlSeconds: 600,
    resendAfterSeconds: 60,
  },
  signup: {
    enabled: true,
    identityVerificationRequired: false,
    methods: { email: true, oauthProviders: ['naver'] },
  },
  identityVerificationMode: 'disabled',
  upbitPdfImportEnabled: false,
  engineMtls: undefined,
}

const immediateSignupCodeResponseTiming = {
  minimumDurationMilliseconds: 0,
  monotonicNow: () => 0,
  wait: async () => {},
}

class FakeNaverAdapter implements OAuthProviderAdapter {
  readonly provider = 'naver' as const

  buildAuthorizationUrl(
    input: Parameters<OAuthProviderAdapter['buildAuthorizationUrl']>[0],
  ) {
    const url = new URL('https://provider.example/authorize')
    url.searchParams.set('state', input.state)
    return url
  }

  async exchangeCode(
    input: Parameters<OAuthProviderAdapter['exchangeCode']>[0],
  ): Promise<NormalizedOAuthIdentity> {
    return {
      provider: 'naver',
      providerSubject: input.code,
      email: 'same-email@example.com',
      emailVerified: false,
    }
  }
}

class CapturingEmailSender implements VerificationEmailSender {
  code: string | undefined
  calls = 0

  async sendVerificationCode(input: {
    to: string
    code: string
    expiresInMinutes: number
  }) {
    this.calls += 1
    this.code = input.code
  }
}

const cookiePair = (setCookie: string | string[] | undefined) => {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie
  return header?.split(';', 1)[0]
}

const cookieHeaderText = (setCookie: string | string[] | undefined) =>
  Array.isArray(setCookie) ? setCookie.join('\n') : (setCookie ?? '')

describe('account authentication routes', () => {
  let now: Date
  let store: MemoryAccountAuthStore
  let sender: CapturingEmailSender
  let context: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    now = new Date('2027-07-20T00:00:00.000Z')
    store = new MemoryAccountAuthStore()
    sender = new CapturingEmailSender()
    context = await buildApp({
      config,
      logger: false,
      accountAuthStore: store,
      oauthAdapters: [new FakeNaverAdapter()],
      verificationEmailSender: sender,
      signupCodeResponseTiming: immediateSignupCodeResponseTiming,
      now: () => now,
    })
  })

  afterEach(async () => {
    await context.app.close()
  })

  const startOAuth = async (intent: 'signup' | 'login') => {
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/start?intent=${intent}&return_to=%2Fdashboard`,
    })
    expect(response.statusCode).toBe(302)
    const location = new URL(response.headers.location as string)
    const state = location.searchParams.get('state')
    const cookie = cookiePair(response.headers['set-cookie'])
    expect(state).toBeTruthy()
    expect(cookie).toMatch(/^daejang_oauth=/u)
    return { state: state as string, cookie: cookie as string }
  }

  it('creates distinct pending users for distinct provider subjects even when email matches', async () => {
    const firstStart = await startOAuth('signup')
    const first = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=subject-a&state=${firstStart.state}`,
      headers: { cookie: firstStart.cookie },
    })
    expect(first.statusCode).toBe(302)
    expect(first.headers.location).toBe('/?onboarding=terms')
    expect(cookieHeaderText(first.headers['set-cookie'])).toContain(
      'daejang_signup=',
    )

    const secondStart = await startOAuth('signup')
    const second = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=subject-b&state=${secondStart.state}`,
      headers: { cookie: secondStart.cookie },
    })
    expect(second.statusCode).toBe(302)

    const firstUser = await store.findUserByIdentity('naver', 'subject-a')
    const secondUser = await store.findUserByIdentity('naver', 'subject-b')
    expect(firstUser?.id).toBeTruthy()
    expect(secondUser?.id).toBeTruthy()
    expect(firstUser?.id).not.toBe(secondUser?.id)
  })

  it('creates a platform account during social signup and reuses it for social login', async () => {
    const signupStart = await startOAuth('signup')
    const signup = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=returning-subject&state=${signupStart.state}`,
      headers: { cookie: signupStart.cookie },
    })

    expect(signup.statusCode).toBe(302)
    expect(signup.headers.location).toBe('/?onboarding=terms')
    const created = await store.findUserByIdentity(
      'naver',
      'returning-subject',
    )
    expect(created).toMatchObject({ status: 'pending' })

    store.setUserStatus(created?.id as string, 'active')
    const loginStart = await startOAuth('login')
    const login = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=returning-subject&state=${loginStart.state}`,
      headers: { cookie: loginStart.cookie },
    })

    expect(login.statusCode).toBe(302)
    expect(login.headers.location).toBe('/dashboard')
    expect(cookieHeaderText(login.headers['set-cookie'])).toContain(
      'daejang_session=',
    )
    expect(
      await store.findUserByIdentity('naver', 'returning-subject'),
    ).toMatchObject({ id: created?.id, status: 'active' })
  })

  it('does not create a user for login intent when the provider identity is unknown', async () => {
    const start = await startOAuth('login')
    const response = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=unknown-subject&state=${start.state}`,
      headers: { cookie: start.cookie },
    })

    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe(
      '/login?auth_error=oauth_account_not_found',
    )
    expect(
      await store.findUserByIdentity('naver', 'unknown-subject'),
    ).toBeUndefined()
  })

  it('issues a normal session only for an active linked provider identity', async () => {
    const userId = '00000000-0000-4000-8000-000000000091'
    store.seedUser({
      id: userId,
      displayName: '김대장',
      status: 'active',
    })
    store.linkIdentity('naver', 'active-subject', userId)
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/oauth/naver/start?intent=login&return_to=%2F%2Fevil.example',
    })
    const state = new URL(response.headers.location as string).searchParams.get(
      'state',
    )
    const oauthCookie = cookiePair(response.headers['set-cookie'])
    expect(oauthCookie).toBeTruthy()

    const crossBrowserCallback = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=active-subject&state=${state}`,
    })
    expect(crossBrowserCallback.statusCode).toBe(302)
    expect(crossBrowserCallback.headers.location).toBe(
      '/login?auth_error=invalid_oauth_transaction',
    )
    expect(crossBrowserCallback.headers['set-cookie']).toBeUndefined()

    const callback = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?code=active-subject&state=${state}`,
      headers: {
        cookie: `${oauthCookie}; ${config.sessionCookieName}=stale-token`,
      },
    })

    expect(callback.statusCode).toBe(302)
    expect(callback.headers.location).toBe('/dashboard')
    const callbackCookies = cookieHeaderText(callback.headers['set-cookie'])
    expect(callbackCookies).toContain('daejang_session=')
    expect(callbackCookies).toContain('daejang_signup=;')
  })

  it('consumes provider-denied transactions without exposing provider descriptions', async () => {
    const start = await startOAuth('login')
    const denied = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?error=access_denied&error_description=provider-secret&state=${start.state}`,
      headers: { cookie: start.cookie },
    })
    expect(denied.statusCode).toBe(302)
    expect(denied.headers.location).toBe(
      '/login?auth_error=oauth_access_denied',
    )
    expect(denied.headers.location).not.toContain('provider-secret')

    const replay = await context.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oauth/naver/callback?error=access_denied&state=${start.state}`,
      headers: { cookie: start.cookie },
    })
    expect(replay.headers.location).toBe(
      '/login?auth_error=invalid_oauth_transaction',
    )
  })

  it('completes email verification and keeps the user in restricted signup state', async () => {
    const originHeaders = { origin: config.publicOrigin }
    const send = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/send-code',
      headers: originHeaders,
      payload: { email: 'User@Example.com', intent: 'signup' },
    })
    expect(send.statusCode).toBe(202)
    expect(sender.code).toMatch(/^[0-9]{6}$/u)

    const verified = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify-code',
      headers: originHeaders,
      payload: {
        email: 'user@example.com',
        intent: 'signup',
        code: sender.code,
      },
    })
    expect(verified.statusCode).toBe(200)
    const verificationToken = verified.json<{
      verificationToken: string
    }>().verificationToken

    const weakPassword = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      headers: originHeaders,
      payload: {
        email: 'user@example.com',
        password: 'password',
        passwordConfirmation: 'password',
        verificationToken,
      },
    })
    expect(weakPassword.statusCode).toBe(400)
    expect(weakPassword.json()).toMatchObject({
      error: { code: 'INVALID_PASSWORD' },
    })

    const signup = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      headers: originHeaders,
      payload: {
        email: 'user@example.com',
        password: 'Password1!',
        passwordConfirmation: 'Password1!',
        verificationToken,
      },
    })
    expect(signup.statusCode).toBe(201)
    expect(signup.json()).toEqual({
      status: 'signup_pending',
      nextStep: 'terms',
    })
    expect(cookieHeaderText(signup.headers['set-cookie'])).toContain(
      'daejang_signup=',
    )

    const pendingLogin = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: originHeaders,
      payload: { email: 'user@example.com', password: 'Password1!' },
    })
    expect(pendingLogin.statusCode).toBe(200)
    expect(pendingLogin.json()).toEqual({
      status: 'signup_pending',
      nextPath: '/?onboarding=terms',
    })
    expect(cookieHeaderText(pendingLogin.headers['set-cookie'])).not.toContain(
      'daejang_session=',
    )

    const credential = await store.findEmailCredential('user@example.com')
    expect(credential).toBeTruthy()
    store.setUserStatus(credential?.user.id as string, 'active')
    const previousSession = await context.sessionService.create({
      user: {
        id: '00000000-0000-4000-8000-000000000099',
        displayName: '이전 사용자',
      },
    })
    const activeLogin = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/login',
      headers: {
        ...originHeaders,
        cookie: `${config.sessionCookieName}=${previousSession.token}`,
      },
      payload: {
        email: 'user@example.com',
        password: 'Password1!',
        returnTo: '//evil.example',
      },
    })
    expect(activeLogin.statusCode).toBe(200)
    expect(activeLogin.json()).toEqual({
      status: 'authenticated',
      nextPath: '/dashboard',
      user: {
        id: credential?.user.id,
        displayName: credential?.user.displayName,
      },
    })
    const activeLoginCookies = cookieHeaderText(
      activeLogin.headers['set-cookie'],
    )
    expect(activeLoginCookies).toContain('daejang_session=')
    expect(activeLoginCookies).toContain('daejang_signup=;')
    expect(
      await context.sessionService.resolve(previousSession.token),
    ).toBeUndefined()

    const existingSignup = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/send-code',
      headers: originHeaders,
      payload: { email: 'user@example.com', intent: 'signup' },
    })
    expect(existingSignup.statusCode).toBe(409)
    expect(existingSignup.json()).toMatchObject({
      error: { code: 'ACCOUNT_ALREADY_EXISTS' },
    })
    expect(sender.calls).toBe(1)
    await expect(
      store.getEligibleEmailChallenge('user@example.com', 'signup', now),
    ).resolves.toBeUndefined()
  })

  it('distinguishes existing accounts from temporary email delivery failures', async () => {
    class ExistingEmailStore extends MemoryAccountAuthStore {
      readonly challengeEmails: string[] = []

      override async findEmailCredential(email: string) {
        if (email === 'existing@example.com') {
          return {
            user: {
              id: '00000000-0000-4000-8000-000000000041',
              displayName: '기존 사용자',
              status: 'active' as const,
            },
            passwordHash: 'not-used',
          }
        }
        return super.findEmailCredential(email)
      }

      override async createEmailChallenge(
        record: Parameters<MemoryAccountAuthStore['createEmailChallenge']>[0],
      ) {
        this.challengeEmails.push(record.email)
        return super.createEmailChallenge(record)
      }
    }

    const outageStore = new ExistingEmailStore()
    let deliveryCalls = 0
    const outageContext = await buildApp({
      config,
      logger: false,
      accountAuthStore: outageStore,
      oauthAdapters: [new FakeNaverAdapter()],
      verificationEmailSender: {
        async sendVerificationCode() {
          deliveryCalls += 1
          throw new Error('sender unavailable')
        },
      },
      signupCodeResponseTiming: immediateSignupCodeResponseTiming,
      now: () => now,
    })

    try {
      const sendCode = (email: string) =>
        outageContext.app.inject({
          method: 'POST',
          url: '/api/v1/auth/email/send-code',
          headers: { origin: config.publicOrigin },
          payload: { email, intent: 'signup' },
        })
      const existing = await sendCode('existing@example.com')
      const unregistered = await sendCode('unregistered@example.com')

      expect(existing.statusCode).toBe(409)
      expect(existing.json()).toMatchObject({
        error: { code: 'ACCOUNT_ALREADY_EXISTS' },
      })
      expect(unregistered.statusCode).toBe(503)
      expect(unregistered.json()).toMatchObject({
        error: { code: 'EMAIL_DELIVERY_FAILED' },
      })
      expect(deliveryCalls).toBe(1)
      expect(outageStore.challengeEmails).toEqual([
        'unregistered@example.com',
      ])
      await expect(
        outageStore.getEligibleEmailChallenge(
          'unregistered@example.com',
          'signup',
          now,
        ),
      ).resolves.toBeUndefined()
    } finally {
      await outageContext.app.close()
    }
  })

  it('publishes signup methods from the server capability', async () => {
    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/auth/capabilities',
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: ['naver'] },
      },
    })
  })

  it('rejects every signup continuation when signup is disabled while keeping login available', async () => {
    const originHeaders = { origin: config.publicOrigin }
    const inFlightOAuthSignup = await startOAuth('signup')
    await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/send-code',
      headers: originHeaders,
      payload: { email: 'pending@example.com', intent: 'signup' },
    })
    const verified = await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/verify-code',
      headers: originHeaders,
      payload: {
        email: 'pending@example.com',
        intent: 'signup',
        code: sender.code,
      },
    })
    await context.app.inject({
      method: 'POST',
      url: '/api/v1/auth/email/signup',
      headers: originHeaders,
      payload: {
        email: 'pending@example.com',
        password: 'Password1!',
        passwordConfirmation: 'Password1!',
        verificationToken: verified.json<{ verificationToken: string }>()
          .verificationToken,
      },
    })

    const disabledContext = await buildApp({
      config: {
        ...config,
        signup: {
          enabled: false,
          identityVerificationRequired: false,
          methods: { email: false, oauthProviders: [] },
        },
      },
      logger: false,
      accountAuthStore: store,
      oauthAdapters: [new FakeNaverAdapter()],
      verificationEmailSender: sender,
      now: () => now,
    })
    try {
      const capability = await disabledContext.app.inject({
        method: 'GET',
        url: '/api/v1/auth/capabilities',
      })
      expect(capability.json()).toEqual({
        signup: {
          enabled: false,
          identityVerificationRequired: false,
          methods: { email: false, oauthProviders: [] },
        },
      })

      const callback = await disabledContext.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/naver/callback?code=blocked-subject&state=${inFlightOAuthSignup.state}`,
        headers: { cookie: inFlightOAuthSignup.cookie },
      })
      expect(callback.statusCode).toBe(302)
      expect(callback.headers.location).toBe(
        '/login?auth_error=signup_unavailable',
      )
      expect(
        await store.findUserByIdentity('naver', 'blocked-subject'),
      ).toBeUndefined()

      for (const request of [
        {
          method: 'GET' as const,
          url: '/api/v1/auth/oauth/naver/start?intent=signup',
        },
        {
          method: 'POST' as const,
          url: '/api/v1/auth/email/send-code',
          headers: originHeaders,
          payload: { email: 'blocked@example.com', intent: 'signup' },
        },
        {
          method: 'POST' as const,
          url: '/api/v1/auth/email/verify-code',
          headers: originHeaders,
          payload: {
            email: 'blocked@example.com',
            intent: 'signup',
            code: '123456',
          },
        },
        {
          method: 'POST' as const,
          url: '/api/v1/auth/email/signup',
          headers: originHeaders,
          payload: {
            email: 'blocked@example.com',
            password: 'Password1!',
            passwordConfirmation: 'Password1!',
            verificationToken: 'x'.repeat(20),
          },
        },
        {
          method: 'POST' as const,
          url: '/api/v1/signup/consents',
          headers: originHeaders,
          payload: {
            locale: 'ko-KR',
            decisions: [
              '00000000-0000-4000-8000-000000000011',
              '00000000-0000-4000-8000-000000000012',
              '00000000-0000-4000-8000-000000000013',
            ].map((legalDocumentId) => ({
              legalDocumentId,
              action: 'accepted',
            })),
          },
        },
      ]) {
        const response = await disabledContext.app.inject(request)
        expect(response.statusCode).toBe(503)
        expect(response.json()).toMatchObject({
          error: { code: 'SIGNUP_UNAVAILABLE' },
        })
      }

      const pendingLogin = await disabledContext.app.inject({
        method: 'POST',
        url: '/api/v1/auth/email/login',
        headers: originHeaders,
        payload: { email: 'pending@example.com', password: 'Password1!' },
      })
      expect(pendingLogin.statusCode).toBe(503)
      expect(pendingLogin.json()).toMatchObject({
        error: { code: 'SIGNUP_UNAVAILABLE' },
      })

      const credential = await store.findEmailCredential('pending@example.com')
      store.setUserStatus(credential?.user.id as string, 'active')
      const activeLogin = await disabledContext.app.inject({
        method: 'POST',
        url: '/api/v1/auth/email/login',
        headers: originHeaders,
        payload: { email: 'pending@example.com', password: 'Password1!' },
      })
      expect(activeLogin.statusCode).toBe(200)
      expect(activeLogin.json()).toMatchObject({ status: 'authenticated' })
    } finally {
      await disabledContext.app.close()
    }
  })

  it('rejects legal document content whose stored digest does not match', async () => {
    for (const [documentType, id] of [
      ['terms', '00000000-0000-4000-8000-000000000021'],
      ['privacy', '00000000-0000-4000-8000-000000000022'],
      [
        'identity_verification',
        '00000000-0000-4000-8000-000000000023',
      ],
    ] as const) {
      const content = `${documentType} test content`
      store.seedLegalDocument({
        id,
        documentType,
        locale: 'ko-KR',
        version: '1.0.0',
        contentHash:
          documentType === 'privacy'
            ? '0'.repeat(64)
            : createHash('sha256').update(content).digest('hex'),
        content,
        effectiveAt: now,
      })
    }

    const response = await context.app.inject({
      method: 'GET',
      url: '/api/v1/legal-documents/current?locale=ko-KR',
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({
      error: { code: 'LEGAL_DOCUMENTS_UNAVAILABLE' },
    })
  })

  it('activates signup after required consent when identity verification is disabled', async () => {
    const noIdentityStore = new MemoryAccountAuthStore()
    const noIdentityConfig: AppConfig = {
      ...config,
      signup: {
        ...config.signup,
        identityVerificationRequired: false,
      },
      identityVerificationMode: 'disabled',
    }
    const noIdentityContext = await buildApp({
      config: noIdentityConfig,
      logger: false,
      accountAuthStore: noIdentityStore,
      oauthAdapters: [new FakeNaverAdapter()],
      verificationEmailSender: new CapturingEmailSender(),
      now: () => now,
    })

    try {
      const start = await noIdentityContext.app.inject({
        method: 'GET',
        url: '/api/v1/auth/oauth/naver/start?intent=signup',
      })
      const authorizationUrl = new URL(start.headers.location as string)
      const state = authorizationUrl.searchParams.get('state') as string
      const oauthCookie = cookiePair(start.headers['set-cookie']) as string
      const callback = await noIdentityContext.app.inject({
        method: 'GET',
        url: `/api/v1/auth/oauth/naver/callback?code=no-identity-subject&state=${state}`,
        headers: { cookie: oauthCookie },
      })
      const signupCookie = /daejang_signup=[^;\n]+/u.exec(
        cookieHeaderText(callback.headers['set-cookie']),
      )?.[0] as string
      expect(signupCookie).toBeTruthy()

      for (const [documentType, id] of [
        ['terms', '00000000-0000-4000-8000-000000000031'],
        ['privacy', '00000000-0000-4000-8000-000000000032'],
        [
          'identity_verification',
          '00000000-0000-4000-8000-000000000033',
        ],
        ['marketing', '00000000-0000-4000-8000-000000000034'],
      ] as const) {
        const content = `${documentType} no identity test content`
        noIdentityStore.seedLegalDocument({
          id,
          documentType,
          locale: 'ko-KR',
          version: '1.0.0',
          contentHash: createHash('sha256').update(content).digest('hex'),
          content,
          effectiveAt: now,
        })
      }

      const documentsResponse = await noIdentityContext.app.inject({
        method: 'GET',
        url: '/api/v1/legal-documents/current?locale=ko-KR',
      })
      const applicableDocuments = documentsResponse.json<{
        documents: Array<CurrentLegalDocument & { required: boolean }>
      }>().documents
      expect(applicableDocuments.map(({ documentType }) => documentType)).toEqual([
        'terms',
        'privacy',
        'marketing',
      ])
      expect(
        applicableDocuments
          .filter(({ required }) => required)
          .map(({ documentType }) => documentType),
      ).toEqual(['terms', 'privacy'])

      const removedMockCompletion = await noIdentityContext.app.inject({
        method: 'POST',
        url: '/api/v1/signup/identity-verification/mock-complete',
        headers: {
          origin: noIdentityConfig.publicOrigin,
          cookie: signupCookie,
        },
      })
      expect(removedMockCompletion.statusCode).toBe(404)

      const consent = await noIdentityContext.app.inject({
        method: 'POST',
        url: '/api/v1/signup/consents',
        headers: {
          origin: noIdentityConfig.publicOrigin,
          cookie: signupCookie,
        },
        payload: {
          locale: 'ko-KR',
          decisions: applicableDocuments.map(({ id, documentType }) => ({
            legalDocumentId: id,
            action: documentType === 'marketing' ? 'withdrawn' : 'accepted',
          })),
        },
      })
      expect(consent.statusCode).toBe(200)
      expect(consent.json()).toEqual({
        status: 'authenticated',
        nextPath: '/dashboard',
        user: {
          id: expect.any(String),
          displayName: 'GIWA 사용자',
        },
      })
      expect(cookieHeaderText(consent.headers['set-cookie'])).toContain(
        'daejang_session=',
      )
      await expect(
        noIdentityStore.findUserByIdentity('naver', 'no-identity-subject'),
      ).resolves.toMatchObject({ status: 'active' })
    } finally {
      await noIdentityContext.app.close()
    }
  })
})
