import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from 'jose'

import { invalidOAuthTransaction } from '../errors.js'
import type {
  NormalizedOAuthIdentity,
  OAuthProviderAdapter,
} from './oauth.js'

type Fetcher = typeof fetch

const containsUnsafeEmailCharacter = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return /\s/u.test(character) || codePoint < 32 || codePoint === 127
  })

const normalizeProviderEmail = (value: unknown) => {
  if (typeof value !== 'string') {
    return undefined
  }
  const normalized = value.trim().toLocaleLowerCase('en-US')
  if (
    normalized.length > 320 ||
    !normalized.includes('@') ||
    containsUnsafeEmailCharacter(normalized)
  ) {
    return undefined
  }
  return normalized
}

const readJson = async (response: Response) => {
  if (!response.ok) {
    throw invalidOAuthTransaction()
  }
  try {
    return (await response.json()) as unknown
  } catch {
    throw invalidOAuthTransaction()
  }
}

const tokenRequest = async (
  fetcher: Fetcher,
  endpoint: string,
  input: {
    clientId: string
    clientSecret: string | undefined
    redirectUri: string
    code: string
    codeVerifier: string | undefined
    state?: string | undefined
  },
) => {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code: input.code,
  })
  if (input.clientSecret) {
    body.set('client_secret', input.clientSecret)
  }
  if (input.codeVerifier) {
    body.set('code_verifier', input.codeVerifier)
  }
  if (input.state) {
    body.set('state', input.state)
  }
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  })
  const payload = await readJson(response)
  if (typeof payload !== 'object' || payload === null) {
    throw invalidOAuthTransaction()
  }
  return payload as Record<string, unknown>
}

const verifiedEmailFromClaims = (claims: JWTPayload) => {
  const email = normalizeProviderEmail(claims.email)
  return {
    email,
    emailVerified: email !== undefined && claims.email_verified === true,
  }
}

export class NaverOAuthAdapter implements OAuthProviderAdapter {
  readonly provider = 'naver' as const

  constructor(private readonly fetcher: Fetcher = fetch) {}

  buildAuthorizationUrl(input: Parameters<OAuthProviderAdapter['buildAuthorizationUrl']>[0]) {
    const url = new URL('https://nid.naver.com/oauth2.0/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: input.client.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      auth_type: 'reauthenticate',
    }).toString()
    return url
  }

  async exchangeCode(
    input: Parameters<OAuthProviderAdapter['exchangeCode']>[0],
  ): Promise<NormalizedOAuthIdentity> {
    const token = await tokenRequest(
      this.fetcher,
      'https://nid.naver.com/oauth2.0/token',
      {
        clientId: input.client.clientId,
        clientSecret: input.client.clientSecret,
        redirectUri: input.redirectUri,
        code: input.code,
        codeVerifier: undefined,
        state: input.state,
      },
    )
    if (typeof token.access_token !== 'string') {
      throw invalidOAuthTransaction()
    }
    const profileResponse = await this.fetcher(
      'https://openapi.naver.com/v1/nid/me',
      {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      },
    )
    const profilePayload = await readJson(profileResponse)
    if (
      typeof profilePayload !== 'object' ||
      profilePayload === null ||
      !('response' in profilePayload) ||
      typeof profilePayload.response !== 'object' ||
      profilePayload.response === null
    ) {
      throw invalidOAuthTransaction()
    }
    const profile = profilePayload.response as Record<string, unknown>
    if (typeof profile.id !== 'string' || !profile.id) {
      throw invalidOAuthTransaction()
    }
    return {
      provider: this.provider,
      providerSubject: profile.id,
      email: normalizeProviderEmail(profile.email),
      // Naver profile email is provider-supplied but is not an OIDC-verified claim.
      emailVerified: false,
    }
  }
}

type OidcAdapterOptions = {
  provider: 'google' | 'kakao'
  authorizationEndpoint: string
  tokenEndpoint: string
  jwksUri: string
  issuer: string | string[]
  scope: string
  prompt: 'login' | 'select_account'
}

class OidcOAuthAdapter implements OAuthProviderAdapter {
  readonly provider: 'google' | 'kakao'
  readonly #jwks

  constructor(
    private readonly options: OidcAdapterOptions,
    private readonly fetcher: Fetcher = fetch,
  ) {
    this.provider = options.provider
    this.#jwks = createRemoteJWKSet(new URL(options.jwksUri), {
      [customFetch]: this.fetcher,
      timeoutDuration: 10_000,
    })
  }

  buildAuthorizationUrl(input: Parameters<OAuthProviderAdapter['buildAuthorizationUrl']>[0]) {
    if (!input.nonce || !input.codeChallenge) {
      throw invalidOAuthTransaction()
    }
    const url = new URL(this.options.authorizationEndpoint)
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: input.client.clientId,
      redirect_uri: input.redirectUri,
      scope: this.options.scope,
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: this.options.prompt,
    }).toString()
    return url
  }

  async exchangeCode(
    input: Parameters<OAuthProviderAdapter['exchangeCode']>[0],
  ): Promise<NormalizedOAuthIdentity> {
    if (!input.nonce || !input.codeVerifier) {
      throw invalidOAuthTransaction()
    }
    const token = await tokenRequest(this.fetcher, this.options.tokenEndpoint, {
      clientId: input.client.clientId,
      clientSecret: input.client.clientSecret,
      redirectUri: input.redirectUri,
      code: input.code,
      codeVerifier: input.codeVerifier,
      state: undefined,
    })
    if (typeof token.id_token !== 'string') {
      throw invalidOAuthTransaction()
    }

    let claims: JWTPayload
    try {
      const verified = await jwtVerify(token.id_token, this.#jwks, {
        issuer: this.options.issuer,
        audience: input.client.clientId,
        clockTolerance: 5,
      })
      claims = verified.payload
    } catch {
      throw invalidOAuthTransaction()
    }
    if (!claims.sub || claims.nonce !== input.nonce) {
      throw invalidOAuthTransaction()
    }
    const email = verifiedEmailFromClaims(claims)
    return {
      provider: this.provider,
      providerSubject: claims.sub,
      email: email.email,
      emailVerified: email.emailVerified,
    }
  }
}

export class GoogleOidcAdapter extends OidcOAuthAdapter {
  constructor(fetcher: Fetcher = fetch) {
    super(
      {
        provider: 'google',
        authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenEndpoint: 'https://oauth2.googleapis.com/token',
        jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
        issuer: ['accounts.google.com', 'https://accounts.google.com'],
        scope: 'openid email',
        prompt: 'select_account',
      },
      fetcher,
    )
  }
}

export class KakaoOidcAdapter extends OidcOAuthAdapter {
  constructor(fetcher: Fetcher = fetch) {
    super(
      {
        provider: 'kakao',
        authorizationEndpoint: 'https://kauth.kakao.com/oauth/authorize',
        tokenEndpoint: 'https://kauth.kakao.com/oauth/token',
        jwksUri: 'https://kauth.kakao.com/.well-known/jwks.json',
        issuer: 'https://kauth.kakao.com',
        scope: 'openid,account_email',
        prompt: 'login',
      },
      fetcher,
    )
  }
}
