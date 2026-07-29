import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRouter } from './AppRouter.tsx'
import {
  resetSessionStateForTests,
  setCurrentUser,
} from './auth/session-store.ts'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

vi.mock('./features/sources/reownAppKit.ts', () => ({
  isReownAppKitConfigured: false,
  reownAppKit: null,
}))

afterEach(() => {
  resetSessionStateForTests()
  window.history.pushState({}, '', '/')
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const payload = url.endsWith('/me')
      ? { user: { id: '00000000-0000-4000-8000-000000000001', displayName: '김대장' } }
      : url.includes('/auth/capabilities')
        ? {
            signup: {
              enabled: false,
              identityVerificationRequired: true,
              methods: { email: false, oauthProviders: [] },
            },
          }
      : url.includes('/dashboard')
        ? { dashboard: { sourceCount: 0, transactionCount: 0, openReviewCount: 0, completedCount: 0, exceptionCount: 0, lastSyncState: '' } }
        : { items: [] }
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})

describe('AppRouter', () => {
  it('keeps the existing landing page at the root path without a session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'AUTHENTICATION_REQUIRED', message: '로그인이 필요합니다' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    window.history.pushState({}, '', '/')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('bootstraps a valid root session once and redirects to the dashboard', async () => {
    window.history.pushState({}, '', '/')
    render(
      <StrictMode>
        <AppRouter />
      </StrictMode>,
    )

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
    expect(
      vi.mocked(fetch).mock.calls.filter(([input]) =>
        String(input).endsWith('/me')),
    ).toHaveLength(1)
  })

  it('enters the authenticated app after email login without a document reload', async () => {
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/me')) {
        meCalls += 1
        if (meCalls === 1) {
          return jsonResponse({
            error: {
              code: 'AUTHENTICATION_REQUIRED',
              message: '로그인이 필요합니다',
            },
          }, 401)
        }
        return jsonResponse({
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '김대장',
          },
        })
      }
      if (url.includes('/auth/capabilities')) {
        return jsonResponse({
          signup: {
            enabled: false,
            identityVerificationRequired: true,
            methods: { email: false, oauthProviders: [] },
          },
        })
      }
      if (url.includes('/auth/email/login')) {
        return jsonResponse({
          status: 'authenticated',
          nextPath: '/dashboard',
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '김대장',
          },
        })
      }
      if (url.includes('/dashboard')) {
        return jsonResponse({
          dashboard: {
            sourceCount: 0,
            transactionCount: 0,
            openReviewCount: 0,
            completedCount: 0,
            exceptionCount: 0,
            lastSyncState: '',
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    window.history.pushState({}, '', '/login')
    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '로그인' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'Password1!' },
    })
    fireEvent.click(screen.getByRole('button', { name: '로그인' }))

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
    expect(screen.queryByText('화면을 준비하고 있습니다')).not.toBeInTheDocument()
    expect(meCalls).toBe(1)
  })

  it('uses the signup completion user without rechecking the session', async () => {
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/me')) {
        meCalls += 1
        return jsonResponse({
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: '로그인이 필요합니다',
          },
        }, 401)
      }
      if (url.includes('/auth/capabilities')) {
        return jsonResponse({
          signup: {
            enabled: true,
            identityVerificationRequired: false,
            methods: { email: true, oauthProviders: [] },
          },
        })
      }
      if (url.includes('/legal-documents/current')) {
        return jsonResponse({
          documents: [
            {
              id: 'legal-terms',
              documentType: 'terms',
              locale: 'ko-KR',
              version: '1.0',
              contentHash: 'terms-hash',
              content: '# 서비스 이용약관',
              effectiveAt: '2026-07-26T00:00:00.000Z',
              required: true,
              consentMode: 'required',
            },
            {
              id: 'legal-privacy',
              documentType: 'privacy',
              locale: 'ko-KR',
              version: '1.0',
              contentHash: 'privacy-hash',
              content: '# 개인정보 처리방침',
              effectiveAt: '2026-07-26T00:00:00.000Z',
              required: false,
              consentMode: 'notice',
            },
          ],
        })
      }
      if (url.includes('/signup/consents')) {
        return jsonResponse({
          status: 'authenticated',
          nextPath: '/dashboard',
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '김대장',
          },
        })
      }
      if (url.includes('/dashboard')) {
        return jsonResponse({
          dashboard: {
            sourceCount: 0,
            transactionCount: 0,
            openReviewCount: 0,
            completedCount: 0,
            exceptionCount: 0,
            lastSyncState: '',
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    window.history.pushState({}, '', '/?onboarding=terms')
    render(<AppRouter />)

    await screen.findByText('[필수] 서비스 이용약관')
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '모두 동의선택 항목에 동의하지 않아도 가입할 수 있어요',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '가입 완료하기' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '서비스로 이동' }),
    )

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
    expect(meCalls).toBe(1)
  })

  it('redirects a protected cold start to login after one 401 response', async () => {
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/me')) {
        meCalls += 1
        return jsonResponse({
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: '로그인이 필요합니다',
          },
        }, 401)
      }
      if (url.includes('/auth/capabilities')) {
        return jsonResponse({
          signup: {
            enabled: false,
            identityVerificationRequired: true,
            methods: { email: false, oauthProviders: [] },
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '로그인' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(meCalls).toBe(1)
  })

  it('routes to login when a protected product request returns 401 after bootstrap', async () => {
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/me')) {
        meCalls += 1
        return jsonResponse({
          user: {
            id: '00000000-0000-4000-8000-000000000001',
            displayName: '김대장',
          },
        })
      }
      if (url.includes('/dashboard')) {
        return jsonResponse({
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: '로그인이 필요합니다',
          },
        }, 401)
      }
      if (url.includes('/auth/capabilities')) {
        return jsonResponse({
          signup: {
            enabled: false,
            identityVerificationRequired: true,
            methods: { email: false, oauthProviders: [] },
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '로그인' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/login')
    expect(meCalls).toBe(1)
  })

  it('shows an explicit error for a malformed successful session response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ user: null })),
    )
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', {
        name: '로그인 상태를 확인하지 못했습니다',
      }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboard')
    expect(
      screen.queryByRole('heading', { name: '로그인' }),
    ).not.toBeInTheDocument()
  })

  it('recovers the public login bootstrap after an HMR session reset', async () => {
    setCurrentUser(null)
    let meCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/me')) {
        meCalls += 1
        return jsonResponse({
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: '로그인이 필요합니다',
          },
        }, 401)
      }
      if (url.includes('/auth/capabilities')) {
        return jsonResponse({
          signup: {
            enabled: false,
            identityVerificationRequired: true,
            methods: { email: false, oauthProviders: [] },
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    window.history.pushState({}, '', '/login')
    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '로그인' }),
    ).toBeInTheDocument()

    act(() => resetSessionStateForTests())

    expect(
      await screen.findByRole('heading', { name: '로그인' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('로그인 상태를 확인하는 중'),
    ).not.toBeInTheDocument()
    expect(meCalls).toBe(1)
  })

  it('renders the dashboard', async () => {
    window.history.pushState({}, '', '/dashboard')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
  })

  it('renders the ledger workspace', async () => {
    window.history.pushState({}, '', '/ledger')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '거래 장부' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Mock 검증 도구')).not.toBeInTheDocument()
  })

  it('navigates between product pages without reloading or rechecking the session', async () => {
    window.history.pushState({}, '', '/dashboard')
    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '세무 장부 요약' }),
    ).toBeInTheDocument()
    const fetchMock = vi.mocked(fetch)
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/me')),
    ).toHaveLength(1)

    fireEvent.click(screen.getByRole('link', { name: '설정' }))

    expect(window.location.pathname).toBe('/settings')
    expect(screen.queryByText('화면을 준비하고 있습니다')).not.toBeInTheDocument()
    expect(
      await screen.findByRole('heading', { name: '설정' }),
    ).toBeInTheDocument()
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/me')),
    ).toHaveLength(1)
  })

  it('renders the data-linked report workspace', async () => {
    window.history.pushState({}, '', '/reports')

    render(<AppRouter />)

    expect(await screen.findByRole('heading', { name: '보고서' })).toBeInTheDocument()
  })

  it('logs the user out from the shared sidebar', async () => {
    setCurrentUser({
      id: '00000000-0000-4000-8000-000000000001',
      displayName: '김대장',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    )
    window.history.pushState({}, '', '/dashboard')
    render(<AppRouter />)

    fireEvent.click(await screen.findByRole('button', { name: /김대장/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '로그아웃' }))

    await waitFor(() => expect(window.location.pathname).toBe('/login'))
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).not.toBeInTheDocument()
  })

  it('renders the source management page', async () => {
    window.history.pushState({}, '', '/sources')

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: '데이터 소스 관리' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
  })

  it.each([
    ['/sources/new', '데이터 소스 추가'],
    ['/sources/new/upbit', 'Upbit PDF 등록'],
    ['/sources/new/upbit/upload', 'Upbit PDF 등록'],
    ['/sources/new/wallet', 'EVM Wallet 연결'],
    ['/sources/new/wallet/connect', 'EVM Wallet 연결'],
  ])('renders the source flow page at %s', async (path, heading) => {
    window.history.pushState({}, '', path)

    render(<AppRouter />)

    expect(
      await screen.findByRole('heading', { name: heading }, { timeout: 3_000 }),
    ).toBeInTheDocument()
  })

  it('fails closed when the Reown project ID is not configured', async () => {
    window.history.pushState({}, '', '/sources/new/wallet/connect')

    render(<AppRouter />)

    fireEvent.click(
      await screen.findByRole('radio', { name: 'WalletConnect (Reown)' }),
    )
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    expect(
      await screen.findByText('선택한 지갑을 사용할 수 없어요'),
    ).toBeInTheDocument()
  })

  it('renders the settings product page', async () => {
    window.history.pushState({}, '', '/settings')

    render(<AppRouter />)

    expect(await screen.findByRole('heading', { name: '설정' })).toBeInTheDocument()
  })
})
