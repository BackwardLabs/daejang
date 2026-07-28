export type SocialProvider = 'kakao' | 'naver' | 'google'
export type AuthIntent = 'signup' | 'login'

export type SignupMethods = {
  email: boolean
  oauthProviders: SocialProvider[]
}

export type AuthCapabilities = {
  signup: {
    enabled: boolean
    methods: SignupMethods
  }
}

type ApiErrorPayload = {
  error?: {
    code?: string
    message?: string
    requestId?: string
    fieldErrors?: Array<{ field?: string; message?: string }>
  }
}

export class WebApiError extends Error {
  readonly status: number
  readonly code: string
  readonly requestId?: string

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message)
    this.name = 'WebApiError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

const defaultApiBase = '/api/v1'

function apiBaseUrl(origin = window.location.origin) {
  const configured = import.meta.env.VITE_WEB_API_BASE_URL?.trim() || defaultApiBase
  const withSlash = configured.endsWith('/') ? configured : `${configured}/`
  return new URL(withSlash, origin)
}

function apiUrl(path: string) {
  return new URL(path.replace(/^\//, ''), apiBaseUrl()).toString()
}

async function requestJson<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })

  const body = await response.json().catch(() => undefined) as
    | T
    | ApiErrorPayload
    | undefined

  if (!response.ok) {
    const payload = body as ApiErrorPayload | undefined
    throw new WebApiError(
      response.status,
      payload?.error?.code || 'REQUEST_FAILED',
      payload?.error?.message || '요청을 처리하지 못했습니다',
      payload?.error?.requestId,
    )
  }

  return body as T
}

export function buildSocialAuthStartUrl(
  provider: SocialProvider,
  intent: AuthIntent,
  origin = window.location.origin,
) {
  const url = new URL(`auth/oauth/${provider}/start`, apiBaseUrl(origin))
  url.searchParams.set('intent', intent)
  url.searchParams.set(
    'return_to',
    intent === 'signup' ? '/?onboarding=terms' : '/dashboard',
  )
  return url.toString()
}

export function startSocialAuth(provider: SocialProvider, intent: AuthIntent) {
  window.location.assign(buildSocialAuthStartUrl(provider, intent))
}

const socialProviders = new Set<SocialProvider>(['kakao', 'naver', 'google'])

function parseAuthCapabilities(value: unknown): AuthCapabilities {
  if (!value || typeof value !== 'object') {
    throw new WebApiError(502, 'INVALID_AUTH_CAPABILITIES', '가입 상태를 확인하지 못했습니다')
  }

  const signup = (value as { signup?: unknown }).signup
  if (!signup || typeof signup !== 'object') {
    throw new WebApiError(502, 'INVALID_AUTH_CAPABILITIES', '가입 상태를 확인하지 못했습니다')
  }

  const enabled = (signup as { enabled?: unknown }).enabled
  const methods = (signup as { methods?: unknown }).methods
  if (typeof enabled !== 'boolean' || !methods || typeof methods !== 'object') {
    throw new WebApiError(502, 'INVALID_AUTH_CAPABILITIES', '가입 상태를 확인하지 못했습니다')
  }

  const email = (methods as { email?: unknown }).email
  const oauthProviders = (methods as { oauthProviders?: unknown }).oauthProviders
  if (
    typeof email !== 'boolean' ||
    !Array.isArray(oauthProviders) ||
    !oauthProviders.every(
      (provider): provider is SocialProvider =>
        typeof provider === 'string' &&
        socialProviders.has(provider as SocialProvider),
    )
  ) {
    throw new WebApiError(502, 'INVALID_AUTH_CAPABILITIES', '가입 상태를 확인하지 못했습니다')
  }

  return {
    signup: {
      enabled,
      methods: { email, oauthProviders },
    },
  }
}

export async function getAuthCapabilities() {
  return parseAuthCapabilities(
    await requestJson<unknown>('auth/capabilities'),
  )
}

export type EmailCodeResponse = {
  status: 'accepted'
  expiresInSeconds: number
  resendAfterSeconds: number
}

export function sendEmailCode(email: string) {
  return requestJson<EmailCodeResponse>('auth/email/send-code', {
    method: 'POST',
    body: { email, intent: 'signup' },
  })
}

export type VerifyEmailCodeResponse = {
  verificationToken: string
  expiresInSeconds: number
}

export function verifyEmailCode(email: string, code: string) {
  return requestJson<VerifyEmailCodeResponse>('auth/email/verify-code', {
    method: 'POST',
    body: { email, code, intent: 'signup' },
  })
}

export function createEmailAccount(input: {
  email: string
  password: string
  passwordConfirmation: string
  verificationToken: string
}) {
  return requestJson<{ status: 'signup_pending'; nextStep: 'terms' }>(
    'auth/email/signup',
    { method: 'POST', body: input },
  )
}

export function loginWithEmail(input: {
  email: string
  password: string
}) {
  return requestJson<
    | { status: 'authenticated'; nextPath: string }
    | { status: 'signup_pending'; nextPath: '/?onboarding=terms' }
  >(
    'auth/email/login',
    { method: 'POST', body: { ...input, returnTo: '/dashboard' } },
  )
}

export type AuthenticatedUser = {
  id: string
  displayName: string
}

export function getCurrentUser() {
  return requestJson<{ user: AuthenticatedUser }>('me')
}

export async function logout() {
  const response = await fetch(apiUrl('auth/logout'), {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })

  if (!response.ok && response.status !== 401) {
    const body = await response.json().catch(() => undefined) as
      | ApiErrorPayload
      | undefined
    throw new WebApiError(
      response.status,
      body?.error?.code || 'LOGOUT_FAILED',
      body?.error?.message || '로그아웃하지 못했습니다',
      body?.error?.requestId,
    )
  }
}

export type LegalDocument = {
  id: string
  documentType: 'terms' | 'privacy' | 'identity_verification' | 'marketing'
  locale: string
  version: string
  contentHash: string
  content: string
  effectiveAt: string
  required: boolean
}

export function getCurrentLegalDocuments() {
  return requestJson<{ documents: LegalDocument[] }>(
    'legal-documents/current?locale=ko-KR',
  )
}

export function submitSignupConsents(
  decisions: Array<{
    legalDocumentId: string
    action: 'accepted' | 'withdrawn'
  }>,
) {
  return requestJson<{
    status: 'accepted'
    nextStep: 'identity_verification'
  }>('signup/consents', {
    method: 'POST',
    body: { locale: 'ko-KR', decisions },
  })
}

export function completeMockIdentityVerification() {
  return requestJson<{
    status: 'authenticated'
    nextPath: '/dashboard'
  }>('signup/identity-verification/mock-complete', {
    method: 'POST',
  })
}
