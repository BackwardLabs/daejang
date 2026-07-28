import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildSocialAuthStartUrl,
  completeMockIdentityVerification,
  sendEmailCode,
} from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Web auth API client', () => {
  it('builds same-origin OAuth start URLs with approved return paths', () => {
    expect(
      buildSocialAuthStartUrl('naver', 'signup', 'https://daejang.backwardlabs.io'),
    ).toBe(
      'https://daejang.backwardlabs.io/api/v1/auth/oauth/naver/start?intent=signup&return_to=%2F%3Fonboarding%3Dterms',
    )

    expect(
      buildSocialAuthStartUrl('google', 'login', 'https://daejang.backwardlabs.io'),
    ).toBe(
      'https://daejang.backwardlabs.io/api/v1/auth/oauth/google/start?intent=login&return_to=%2Fdashboard',
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

  it('uses the server-side development gate for mock identity completion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'authenticated',
          nextPath: '/dashboard',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(completeMockIdentityVerification()).resolves.toEqual({
      status: 'authenticated',
      nextPath: '/dashboard',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/signup/identity-verification/mock-complete',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
      }),
    )
  })
})
