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
