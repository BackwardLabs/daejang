import { WebApiError, type AuthenticatedUser } from './api.ts'

type LocalSessionResponse = {
  user?: unknown
}

const userIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export async function bootstrapLocalReportAttestationSession(): Promise<{
  user: AuthenticatedUser
}> {
  const response = await fetch('/api/v1/dev/report-attestation-session', {
    method: 'POST',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new WebApiError(
      response.status,
      'LOCAL_REPORT_ATTESTATION_SESSION_FAILED',
      'GIWA-28 로컬 세션을 만들지 못했습니다',
    )
  }

  const payload = (await response.json()) as LocalSessionResponse
  const user = payload.user
  if (
    !user ||
    typeof user !== 'object' ||
    typeof (user as { id?: unknown }).id !== 'string' ||
    !userIdPattern.test((user as { id: string }).id) ||
    typeof (user as { displayName?: unknown }).displayName !== 'string' ||
    !(user as { displayName: string }).displayName.trim()
  ) {
    throw new WebApiError(
      502,
      'INVALID_AUTH_RESPONSE',
      'GIWA-28 로컬 회원 정보를 확인하지 못했습니다',
    )
  }

  return {
    user: {
      id: (user as { id: string }).id,
      displayName: (user as { displayName: string }).displayName,
    },
  }
}
