export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export const unauthorized = () =>
  new ApiError(401, 'AUTHENTICATION_REQUIRED', '로그인이 필요합니다.')

export const resourceNotFound = () =>
  new ApiError(404, 'RESOURCE_NOT_FOUND', '요청한 리소스를 찾을 수 없습니다.')

export const invalidOrigin = () =>
  new ApiError(403, 'INVALID_REQUEST_ORIGIN', '요청 출처를 확인할 수 없습니다.')

export const rateLimitExceeded = (retryAfterSeconds?: number) =>
  new ApiError(
    429,
    'RATE_LIMIT_EXCEEDED',
    '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) },
  )

export const sessionRotationConflict = () =>
  new ApiError(
    409,
    'SESSION_ROTATION_CONFLICT',
    '세션 상태가 변경되었습니다. 현재 로그인 상태를 다시 확인해 주세요.',
  )

export const invalidWalletChallenge = () =>
  new ApiError(
    409,
    'WALLET_CHALLENGE_INVALID',
    '지갑 서명 요청이 만료되었거나 이미 사용되었습니다.',
  )

export const invalidWalletSignature = () =>
  new ApiError(
    400,
    'WALLET_SIGNATURE_INVALID',
    '연결한 지갑의 서명을 확인할 수 없습니다.',
  )

export const oauthProviderUnavailable = () =>
  new ApiError(
    503,
    'OAUTH_PROVIDER_UNAVAILABLE',
    '선택한 로그인 수단을 현재 사용할 수 없습니다.',
  )

export const invalidOAuthTransaction = () =>
  new ApiError(
    400,
    'INVALID_OAUTH_TRANSACTION',
    '로그인 요청이 만료되었거나 이미 사용되었습니다.',
  )

export const oauthAccountNotFound = () =>
  new ApiError(
    404,
    'OAUTH_ACCOUNT_NOT_FOUND',
    '연결된 GIWA 계정을 찾을 수 없습니다.',
  )

export const accountAlreadyExists = () =>
  new ApiError(
    409,
    'ACCOUNT_ALREADY_EXISTS',
    '이미 가입된 계정입니다. 로그인해 주세요.',
  )

export const accountUnavailable = () =>
  new ApiError(
    403,
    'ACCOUNT_UNAVAILABLE',
    '현재 이 계정으로 로그인할 수 없습니다.',
  )

export const signupAuthenticationRequired = () =>
  new ApiError(
    401,
    'SIGNUP_AUTHENTICATION_REQUIRED',
    '회원가입 확인을 다시 진행해 주세요.',
  )

export const signupUnavailable = () =>
  new ApiError(
    503,
    'SIGNUP_UNAVAILABLE',
    '현재 회원가입을 진행할 수 없습니다.',
  )

export const invalidEmailVerification = () =>
  new ApiError(
    400,
    'INVALID_EMAIL_VERIFICATION',
    '인증번호가 올바르지 않거나 만료되었습니다.',
  )

export const emailDeliveryFailed = () =>
  new ApiError(
    503,
    'EMAIL_DELIVERY_FAILED',
    '인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.',
  )

export const invalidCredentials = () =>
  new ApiError(
    401,
    'INVALID_CREDENTIALS',
    '이메일 또는 비밀번호를 확인해 주세요.',
  )

export const invalidPassword = () =>
  new ApiError(
    400,
    'INVALID_PASSWORD',
    '비밀번호는 영문, 숫자, 특수문자를 각각 하나 이상 포함한 8자 이상이어야 합니다.',
  )

export const legalDocumentsUnavailable = () =>
  new ApiError(
    503,
    'LEGAL_DOCUMENTS_UNAVAILABLE',
    '현재 적용할 약관을 불러오지 못했습니다.',
  )

export const identityVerificationUnavailable = () =>
  new ApiError(
    503,
    'IDENTITY_VERIFICATION_UNAVAILABLE',
    '현재 본인확인을 진행할 수 없습니다.',
  )
