import {
  getSessionRevision,
  invalidateSessionAtRevision,
} from '../auth/session-store.ts'

const apiBaseUrl = (import.meta.env.VITE_WEB_API_BASE_URL || '/api/v1').replace(
  /\/$/,
  '',
)
export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    status: number,
    code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = code
  }
}

async function toApiError(response: Response) {
  const fallbackMessage = `API 요청을 처리하지 못했습니다. (${response.status})`
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string }
    }
    return new ApiClientError(
      response.status,
      payload.error?.code ?? 'API_REQUEST_FAILED',
      payload.error?.message ?? fallbackMessage,
    )
  } catch {
    return new ApiClientError(response.status, 'API_REQUEST_FAILED', fallbackMessage)
  }
}

async function send(path: string, init: RequestInit) {
  return fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
}

async function sendWithSessionBoundary(path: string, init: RequestInit) {
  const sessionRevision = getSessionRevision()
  const response = await send(path, init)
  if (response.status === 401) {
    invalidateSessionAtRevision(sessionRevision)
  }
  return response
}

export async function requestRaw(path: string, init: RequestInit = {}) {
  const response = await sendWithSessionBoundary(path, init)
  if (!response.ok) {
    throw await toApiError(response)
  }
  return response
}

export async function requestApi<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await sendWithSessionBoundary(path, init)
  if (!response.ok) {
    throw await toApiError(response)
  }
  if (response.status === 204) {
    return undefined as T
  }
  return (await response.json()) as T
}
