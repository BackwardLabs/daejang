import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose'
import { describe, expect, it } from 'vitest'

import {
  GoogleOidcAdapter,
  KakaoOidcAdapter,
  NaverOAuthAdapter,
} from './oauth-providers.js'

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('OAuth provider adapters', () => {
  it('builds a Kakao authorization URL with comma-separated OIDC scopes', () => {
    const adapter = new KakaoOidcAdapter()

    const url = adapter.buildAuthorizationUrl({
      client: {
        clientId: 'kakao-client-id',
        clientSecret: 'kakao-client-secret',
      },
      redirectUri:
        'https://daejang.backwardlabs.io/api/v1/auth/oauth/kakao/callback',
      state: 'oauth-state',
      nonce: 'oidc-nonce',
      codeChallenge: 'pkce-code-challenge',
    })

    expect(url.origin).toBe('https://kauth.kakao.com')
    expect(url.pathname).toBe('/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('openid,account_email')
    expect(url.searchParams.get('state')).toBe('oauth-state')
    expect(url.searchParams.get('nonce')).toBe('oidc-nonce')
    expect(url.searchParams.get('code_challenge')).toBe(
      'pkce-code-challenge',
    )
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('returns the original state to the Naver token endpoint', async () => {
    const requests: Array<{ url: string; body: string | undefined }> = []
    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      requests.push({
        url,
        body:
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : undefined,
      })
      if (url.includes('/oauth2.0/token')) {
        return jsonResponse({ access_token: 'provider-access-token' })
      }
      return jsonResponse({
        response: { id: 'naver-subject', email: 'USER@example.com' },
      })
    }) as typeof fetch
    const adapter = new NaverOAuthAdapter(fetcher)

    await expect(
      adapter.exchangeCode({
        client: { clientId: 'client-id', clientSecret: 'client-secret' },
        redirectUri:
          'https://daejang.backwardlabs.io/api/v1/auth/oauth/naver/callback',
        code: 'authorization-code',
        state: 'original-state',
        nonce: undefined,
        codeVerifier: undefined,
      }),
    ).resolves.toEqual({
      provider: 'naver',
      providerSubject: 'naver-subject',
      email: 'user@example.com',
      emailVerified: false,
    })

    const tokenBody = new URLSearchParams(requests[0]?.body)
    expect(tokenBody.get('state')).toBe('original-state')
    expect(tokenBody.get('code')).toBe('authorization-code')
    expect(requests[1]?.url).toBe('https://openapi.naver.com/v1/nid/me')
  })

  it.each(['accounts.google.com', 'https://accounts.google.com'])(
    'accepts the documented Google issuer %s after signature and nonce verification',
    async (issuer) => {
      const { publicKey, privateKey } = await generateKeyPair('RS256')
      const publicJwk = await exportJWK(publicKey)
      const nonce = 'expected-nonce'
      const idToken = await new SignJWT({
        sub: 'google-subject',
        nonce,
        email: 'USER@example.com',
        email_verified: true,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(issuer)
        .setAudience('google-client-id')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey)
      const fetcher = (async (input: string | URL | Request) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url
        if (url.includes('/token')) {
          return jsonResponse({ id_token: idToken })
        }
        if (url.includes('/certs')) {
          return jsonResponse({
            keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
          })
        }
        throw new Error(`Unexpected URL: ${url}`)
      }) as typeof fetch
      const adapter = new GoogleOidcAdapter(fetcher)

      await expect(
        adapter.exchangeCode({
          client: {
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
          },
          redirectUri:
            'https://daejang.backwardlabs.io/api/v1/auth/oauth/google/callback',
          code: 'authorization-code',
          state: 'oauth-state',
          nonce,
          codeVerifier: 'pkce-verifier',
        }),
      ).resolves.toEqual({
        provider: 'google',
        providerSubject: 'google-subject',
        email: 'user@example.com',
        emailVerified: true,
      })
    },
  )
})
