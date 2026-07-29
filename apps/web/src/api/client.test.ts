import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSessionSnapshot,
  resetSessionStateForTests,
  setCurrentUser,
} from '../auth/session-store.ts'
import { requestApi, requestRaw, requestRawResponse } from './client.ts'

afterEach(() => {
  resetSessionStateForTests()
  vi.unstubAllGlobals()
})

describe('product API client', () => {
  it('includes the authenticated session for product requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestApi<{ ok: boolean }>('/syncs')).resolves.toEqual({
      ok: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/syncs',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it.each([
    ['JSON', () => requestApi('/dashboard')],
    ['raw', () => requestRaw('/uploads/upload-1/content')],
  ])('invalidates the current session after a protected %s request returns 401', async (_kind, request) => {
    setCurrentUser({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '기존 사용자',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: '로그인이 필요합니다',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    await expect(request()).rejects.toMatchObject({ status: 401 })
    expect(getSessionSnapshot()).toEqual({
      status: 'anonymous',
      user: null,
    })
  })

  it('invalidates a session that is still being resolved after a protected request returns 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: '로그인이 필요합니다',
            },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )

    await expect(requestApi('/dashboard')).rejects.toMatchObject({ status: 401 })
    expect(getSessionSnapshot()).toEqual({
      status: 'anonymous',
      user: null,
    })
  })

  it('ignores a late 401 from a request started before a newer login', async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve
    })
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(responsePromise))
    setCurrentUser({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '이전 사용자',
    })

    const pendingRequest = requestApi('/dashboard')
    setCurrentUser({
      id: '00000000-0000-4000-8000-000000000002',
      displayName: '새 사용자',
    })
    resolveResponse?.(
      new Response(
        JSON.stringify({
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: '로그인이 필요합니다',
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    )

    await expect(pendingRequest).rejects.toMatchObject({ status: 401 })
    expect(getSessionSnapshot()).toEqual({
      status: 'authenticated',
      user: {
        id: '00000000-0000-4000-8000-000000000002',
        displayName: '새 사용자',
      },
    })
  })

  it('applies the same session boundary when a caller needs to inspect a 402 response', async () => {
    setCurrentUser({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '기존 사용자',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
    )

    const response = await requestRawResponse('/tax-reports/2027/current/download')

    expect(response.status).toBe(401)
    expect(getSessionSnapshot()).toEqual({
      status: 'anonymous',
      user: null,
    })
  })
})
