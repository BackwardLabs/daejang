import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSocialAuthStartUrl,
  consumeAuthNotice,
  getAuthCapabilities,
  getCurrentUser,
  loginWithEmail,
  requestSocialAuthStart,
  sendEmailCode,
  submitSignupConsents,
} from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Web auth API client', () => {
  it('loads the server-owned signup capability contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        signup: {
          enabled: true,
          identityVerificationRequired: false,
          methods: { email: true, oauthProviders: ['naver'] },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAuthCapabilities()).resolves.toEqual({
      signup: {
        enabled: true,
        identityVerificationRequired: false,
        methods: { email: true, oauthProviders: ['naver'] },
      },
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/capabilities',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('rejects malformed capability responses so signup stays fail-closed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            signup: {
              enabled: true,
              identityVerificationRequired: true,
              methods: { email: true, oauthProviders: ['unknown-provider'] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(getAuthCapabilities()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_AUTH_CAPABILITIES',
    })
  })

  it('builds OAuth start URLs without exposing intent or return paths', () => {
    expect(
      buildSocialAuthStartUrl('naver', 'https://daejang.backwardlabs.io'),
    ).toBe(
      'https://daejang.backwardlabs.io/api/v1/auth/oauth/naver/start',
    )

    expect(
      buildSocialAuthStartUrl('google', 'https://daejang.backwardlabs.io'),
    ).toBe(
      'https://daejang.backwardlabs.io/api/v1/auth/oauth/google/start',
    )
  })

  it('sends OAuth intent and return path in a POST body', async () => {
    const authorizationUrl =
      'https://kauth.kakao.com/oauth/authorize?state=opaque-state'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizationUrl }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestSocialAuthStart('kakao', 'login')).resolves.toBe(
      authorizationUrl,
    )
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/oauth/kakao/start',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ intent: 'login', returnTo: '/dashboard' }),
      }),
    )
  })

  it('uses the clean signup terms path for social signup', async () => {
    const authorizationUrl =
      'https://kauth.kakao.com/oauth/authorize?state=opaque-state'
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ authorizationUrl }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await requestSocialAuthStart('kakao', 'signup')

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/oauth/kakao/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          intent: 'signup',
          returnTo: '/signup/terms',
        }),
      }),
    )
  })

  it('consumes callback notices through a credentialed POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'oauth_access_denied' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(consumeAuthNotice()).resolves.toBe('oauth_access_denied')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/oauth/result/consume',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })

  it('sends email verification through the public API with credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'accepted',
          expiresInSeconds: 300,
          resendAfterSeconds: 60,
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(sendEmailCode('user@example.com')).resolves.toMatchObject({
      status: 'accepted',
      expiresInSeconds: 300,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/auth/email/send-code',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ email: 'user@example.com', intent: 'signup' }),
      }),
    )
  })

  it('keeps stable server errors available to the UI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'EMAIL_RATE_LIMITED',
              message: '잠시 후 다시 시도해 주세요',
              requestId: 'request-1',
            },
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(sendEmailCode('user@example.com')).rejects.toMatchObject({
      status: 429,
      code: 'EMAIL_RATE_LIMITED',
      requestId: 'request-1',
    })
  })

  it('rejects a malformed successful current-user response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ user: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(getCurrentUser()).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_AUTH_RESPONSE',
    })
  })

  it('accepts canonical account UUIDs without restricting the UUID version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: {
              id: '018f47a2-4b1c-7def-8abc-0123456789ab',
              displayName: '김대장',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(getCurrentUser()).resolves.toEqual({
      user: {
        id: '018f47a2-4b1c-7def-8abc-0123456789ab',
        displayName: '김대장',
      },
    })
  })

  it('rejects a malformed successful email-login response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'authenticated',
            nextPath: '/dashboard',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    await expect(
      loginWithEmail({ email: 'user@example.com', password: 'Password1!' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_AUTH_RESPONSE',
    })
  })

  it('rejects malformed authenticated signup-completion responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'authenticated',
          nextPath: '//external.example',
          user: {
            id: 'not-a-user-id',
            displayName: '',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitSignupConsents([])).rejects.toMatchObject({
      status: 502,
      code: 'INVALID_AUTH_RESPONSE',
    })
  })
})
