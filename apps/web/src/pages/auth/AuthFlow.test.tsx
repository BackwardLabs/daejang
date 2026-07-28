import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../../App.tsx'
import type { AuthCapabilities } from '../../auth/api.ts'
import { OnboardingFlow } from './OnboardingFlow.tsx'

const startSocialAuthMock = vi.hoisted(() => vi.fn())

vi.mock('../../auth/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/api.ts')>()
  return {
    ...actual,
    startSocialAuth: startSocialAuthMock,
  }
})

const documents = [
  {
    id: 'legal-terms',
    documentType: 'terms',
    locale: 'ko-KR',
    version: '1.0',
    contentHash: 'hash-terms',
    content: '# 서비스 이용약관\n\n서버에서 제공한 이용약관 본문입니다',
    effectiveAt: '2026-07-26T00:00:00.000Z',
    required: true,
  },
  {
    id: 'legal-privacy',
    documentType: 'privacy',
    locale: 'ko-KR',
    version: '1.0',
    contentHash: 'hash-privacy',
    content: '# 개인정보 처리방침\n\n서버에서 제공한 개인정보 처리방침입니다',
    effectiveAt: '2026-07-26T00:00:00.000Z',
    required: true,
  },
  {
    id: 'legal-identity',
    documentType: 'identity_verification',
    locale: 'ko-KR',
    version: '1.0',
    contentHash: 'hash-identity',
    content: '# 본인확인 안내\n\n서버에서 제공한 본인확인 안내입니다',
    effectiveAt: '2026-07-26T00:00:00.000Z',
    required: true,
  },
  {
    id: 'legal-marketing',
    documentType: 'marketing',
    locale: 'ko-KR',
    version: '1.0',
    contentHash: 'hash-marketing',
    content: '# 마케팅 수신 안내\n\n서버에서 제공한 선택 동의 안내입니다',
    effectiveAt: '2026-07-26T00:00:00.000Z',
    required: false,
  },
]

const signupCapabilities: AuthCapabilities = {
  signup: {
    enabled: true,
    methods: {
      email: true,
      oauthProviders: ['kakao', 'naver', 'google'],
    },
  },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Response | Promise<Response>

function withSignupCapabilities(handler: FetchHandler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/auth/capabilities')) {
      return jsonResponse(signupCapabilities)
    }
    return handler(input, init)
  })
}

async function openSignupMethodsFromLanding() {
  fireEvent.click(screen.getAllByRole('button', { name: '시작하기' })[0]!)
  expect(
    screen.getByRole('heading', { name: 'Daejang 시작하기' }),
  ).toBeInTheDocument()
  const signupButton = screen.getByRole('button', { name: /^회원가입/ })
  await waitFor(() => expect(signupButton).toBeEnabled())
  fireEvent.click(signupButton)
}

beforeEach(() => {
  startSocialAuthMock.mockReset()
  window.history.replaceState(null, '', '/')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/capabilities')) {
        return jsonResponse(signupCapabilities)
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('authentication flows', () => {
  it('redirects directly to social providers and starts each flow only once', async () => {
    window.history.replaceState(null, '', '/login')
    const { unmount } = render(<App />)

    const loginRedirect = screen.getByRole('button', {
      name: 'Google로 로그인',
    })
    const otherLoginProvider = screen.getByRole('button', {
      name: '카카오 로그인',
    })
    fireEvent.click(loginRedirect)
    fireEvent.click(loginRedirect)
    fireEvent.click(otherLoginProvider)

    expect(startSocialAuthMock).toHaveBeenCalledTimes(1)
    expect(startSocialAuthMock).toHaveBeenLastCalledWith('google', 'login')
    expect(loginRedirect).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Google 로그인 화면으로 이동' }),
    ).not.toBeInTheDocument()
    unmount()

    window.history.replaceState(null, '', '/')
    render(<App />)
    await openSignupMethodsFromLanding()
    const signupRedirect = screen.getByRole('button', {
      name: '구글로 시작하기',
    })
    const otherSignupProvider = screen.getByRole('button', {
      name: '카카오로 시작하기',
    })
    fireEvent.click(signupRedirect)
    fireEvent.click(signupRedirect)
    fireEvent.click(otherSignupProvider)

    expect(startSocialAuthMock).toHaveBeenCalledTimes(2)
    expect(startSocialAuthMock).toHaveBeenLastCalledWith('google', 'signup')
    expect(signupRedirect).toBeDisabled()
    expect(
      screen.queryByRole('button', { name: 'Google 로그인 화면으로 이동' }),
    ).not.toBeInTheDocument()
  })

  it('removes the landing login button and lets the start screen open login', () => {
    render(<App />)

    expect(
      screen.queryByRole('button', { name: '로그인' }),
    ).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '시작하기' })[0]!)
    expect(
      screen.getByRole('heading', { name: 'Daejang 시작하기' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: '로그인 또는 회원가입' }),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^로그인/ }))

    expect(window.location.pathname).toBe('/login')
    expect(screen.getByRole('heading', { name: '로그인' })).toBeInTheDocument()
  })

  it('opens signup methods directly from the login page account action', async () => {
    window.history.replaceState(null, '', '/login')
    render(<App />)

    const signupButtons = await screen.findAllByRole('button', {
      name: '계정 만들기',
    })
    fireEvent.click(signupButtons[signupButtons.length - 1]!)

    expect(
      screen.getByRole('heading', { name: 'Daejang 계정 만들기' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Daejang 시작하기' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('region', { name: '회원가입' }),
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '← 로그인 또는 회원가입 선택' }),
    )
    expect(
      screen.getByRole('heading', { name: 'Daejang 시작하기' }),
    ).toBeInTheDocument()
  })

  it('exposes /login while redirecting direct /signup access to the landing', () => {
    window.history.replaceState(null, '', '/login')
    const { unmount } = render(<App />)
    expect(screen.getByRole('heading', { name: '로그인' })).toBeInTheDocument()
    unmount()

    window.history.replaceState(null, '', '/signup')
    render(<App />)
    expect(window.location.pathname).toBe('/')
    expect(
      screen.getByRole('heading', { name: /흩어진 디지털 자산 기록/ }),
    ).toBeInTheDocument()
  })

  it('explains when signup becomes unavailable during an OAuth callback', () => {
    window.history.replaceState(
      null,
      '',
      '/login?auth_error=signup_unavailable',
    )
    render(<App />)

    expect(
      screen.getByText(
        '현재 신규 가입을 받을 수 없습니다. 기존 계정으로 로그인해 주세요',
      ),
    ).toBeInTheDocument()
  })

  it('uses real email API operations before showing server-backed terms', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/capabilities')) {
        return jsonResponse(signupCapabilities)
      }
      if (url.includes('/send-code')) {
        return jsonResponse(
          { status: 'accepted', expiresInSeconds: 300, resendAfterSeconds: 60 },
          202,
        )
      }
      if (url.includes('/verify-code')) {
        return jsonResponse({ verificationToken: 'verification-token', expiresInSeconds: 300 })
      }
      if (url.includes('/email/signup')) {
        return jsonResponse({ status: 'signup_pending', nextStep: 'terms' }, 201)
      }
      if (url.includes('/legal-documents/current')) {
        return jsonResponse({ documents })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))
    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 보내기' }))
    expect(await screen.findByText('인증번호를 보냈습니다')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('인증번호'), {
      target: { value: '123456' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 확인' }))
    expect(await screen.findByText('이메일 확인을 완료했습니다')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'Password1!' },
    })
    fireEvent.change(screen.getByLabelText('비밀번호 확인'), {
      target: { value: 'Password1!' },
    })
    fireEvent.click(screen.getByRole('button', { name: '약관 확인하기' }))

    expect(
      await screen.findByRole('heading', { name: '약관과 개인정보 안내' }),
    ).toBeInTheDocument()
    expect(await screen.findByText('[필수] 서비스 이용약관')).toBeInTheDocument()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/email/signup'),
      expect.objectContaining({
        body: JSON.stringify({
          email: 'user@example.com',
          password: 'Password1!',
          passwordConfirmation: 'Password1!',
          verificationToken: 'verification-token',
        }),
      }),
    )
  })

  it('shows an existing-account error beside the signup email field', async () => {
    vi.stubGlobal(
      'fetch',
      withSignupCapabilities(async () =>
        jsonResponse(
          {
            error: {
              code: 'ACCOUNT_ALREADY_EXISTS',
              message: '이미 가입된 계정입니다. 로그인해 주세요.',
            },
          },
          409,
        ),
      ),
    )
    render(<App />)
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))

    const emailInput = screen.getByLabelText('이메일 주소')
    fireEvent.change(emailInput, {
      target: { value: 'existing@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 보내기' }))

    const emailField = emailInput.closest('.auth-field')
    expect(emailField).not.toBeNull()
    expect(
      await within(emailField as HTMLElement).findByRole('alert'),
    ).toHaveTextContent('이미 가입된 계정입니다. 로그인해 주세요')
    expect(screen.queryByLabelText('인증번호')).not.toBeInTheDocument()
    expect(screen.queryByText('인증번호를 보냈습니다')).not.toBeInTheDocument()
  })

  it('clears an old verification form when resend discovers an existing account', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: 'accepted', expiresInSeconds: 300, resendAfterSeconds: 60 },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'ACCOUNT_ALREADY_EXISTS',
              message: '이미 가입된 계정입니다. 로그인해 주세요.',
            },
          },
          409,
        ),
      )
    vi.stubGlobal('fetch', withSignupCapabilities(fetchMock))
    render(<App />)
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))

    const emailInput = screen.getByLabelText('이메일 주소')
    fireEvent.change(emailInput, {
      target: { value: 'existing-later@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 보내기' }))
    expect(await screen.findByLabelText('인증번호')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }))

    const emailField = emailInput.closest('.auth-field')
    expect(emailField).not.toBeNull()
    expect(
      await within(emailField as HTMLElement).findByRole('alert'),
    ).toHaveTextContent(/^이미 가입된 계정입니다\. 로그인해 주세요$/)
    expect(screen.queryByLabelText('인증번호')).not.toBeInTheDocument()
  })

  it('keeps an active verification form after a temporary resend failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: 'accepted', expiresInSeconds: 300, resendAfterSeconds: 60 },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'EMAIL_DELIVERY_FAILED',
              message: '인증번호를 보내지 못했습니다.',
            },
          },
          503,
        ),
      )
    vi.stubGlobal('fetch', withSignupCapabilities(fetchMock))
    render(<App />)
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))

    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'retry@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 보내기' }))
    expect(await screen.findByLabelText('인증번호')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 보내기' }))

    expect(
      await screen.findByText('인증번호를 보내지 못했습니다'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('인증번호')).toBeInTheDocument()
  })

  it('replaces send success with a code error beside the verification field', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { status: 'accepted', expiresInSeconds: 300, resendAfterSeconds: 60 },
          202,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'INVALID_EMAIL_VERIFICATION',
              message: '인증번호가 올바르지 않거나 만료되었습니다.',
            },
          },
          400,
        ),
      )
    vi.stubGlobal('fetch', withSignupCapabilities(fetchMock))
    render(<App />)
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))

    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'user@example.com' },
    })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 보내기' }))
    expect(await screen.findByText('인증번호를 보냈습니다')).toBeInTheDocument()

    const codeInput = screen.getByLabelText('인증번호')
    fireEvent.change(codeInput, { target: { value: '508840' } })
    fireEvent.click(screen.getByRole('button', { name: '인증번호 확인' }))

    const codeField = codeInput.closest('.auth-field')
    expect(codeField).not.toBeNull()
    expect(
      await within(codeField as HTMLElement).findByRole('alert'),
    ).toHaveTextContent('인증번호가 올바르지 않거나 만료되었습니다')
    expect(screen.queryByText('인증번호를 보냈습니다')).not.toBeInTheDocument()
  })

  it('resumes pending email accounts at the terms step', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/capabilities')) {
          return jsonResponse(signupCapabilities)
        }
        if (url.includes('/auth/email/login')) {
          return jsonResponse({
            status: 'signup_pending',
            nextPath: '/?onboarding=terms',
          })
        }
        if (url.includes('/legal-documents/current')) {
          return jsonResponse({ documents })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    window.history.replaceState(null, '', '/login')
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: '이메일로 로그인' }))
    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'pending@example.com' },
    })
    fireEvent.change(screen.getByLabelText('비밀번호'), {
      target: { value: 'Password1!' },
    })
    fireEvent.click(screen.getByRole('button', { name: '로그인' }))

    expect(
      await screen.findByRole('heading', { name: '약관과 개인정보 안내' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/')
  })

  it('clears email credentials after leaving the email signup screen', async () => {
    render(<App />)
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))
    fireEvent.change(screen.getByLabelText('이메일 주소'), {
      target: { value: 'private@example.com' },
    })
    fireEvent.click(screen.getByRole('link', { name: '고객지원' }))
    expect(screen.getByRole('heading', { name: '고객지원' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '서비스로 돌아가기' }))
    await openSignupMethodsFromLanding()
    fireEvent.click(screen.getByRole('button', { name: '이메일로 가입하기' }))
    expect(screen.getByLabelText('이메일 주소')).toHaveValue('')
  })

  it('shows policy content above the consent screen in a modal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/capabilities')) return jsonResponse(signupCapabilities)
        if (url.includes('/legal-documents/current')) return jsonResponse({ documents })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    window.history.replaceState(null, '', '/?onboarding=terms')
    render(<App />)

    expect(await screen.findByText('[필수] 서비스 이용약관')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: '내용 보기' })[0]!)
    const dialog = screen.getByRole('dialog', { name: '서비스 이용약관' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveTextContent('Daejang 서비스 이용에 필요한 기본 조건')
    expect(dialog).toHaveTextContent('서버에서 제공한 이용약관 본문입니다')
    fireEvent.click(screen.getByRole('button', { name: '닫기' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('renders the current server policy on the public terms page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/capabilities')) return jsonResponse(signupCapabilities)
        if (url.includes('/legal-documents/current')) return jsonResponse({ documents })
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    window.history.replaceState(null, '', '/terms')
    render(<App />)

    expect(
      await screen.findByRole('heading', { name: '서비스 이용약관' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText('서버에서 제공한 이용약관 본문입니다'),
    ).toBeInTheDocument()
    expect(screen.getByText(/버전 1.0/)).toBeInTheDocument()
  })

  it('uses the authenticated next path after identity verification', async () => {
    vi.stubEnv('VITE_DEV_IDENTITY_MOCK_ENABLED', 'true')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/auth/capabilities')) {
          return jsonResponse(signupCapabilities)
        }
        if (url.includes('/legal-documents/current')) {
          return jsonResponse({ documents })
        }
        if (url.includes('/signup/consents')) {
          return jsonResponse({
            status: 'accepted',
            nextStep: 'identity_verification',
          })
        }
        if (url.includes('/identity-verification/mock-complete')) {
          return jsonResponse({
            status: 'authenticated',
            nextPath: '/dashboard',
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )
    const onAuthenticated = vi.fn()
    const onExit = vi.fn()

    render(
      <OnboardingFlow
        initialScreen="consent"
        onAuthenticated={onAuthenticated}
        onExit={onExit}
        onLogin={vi.fn()}
        onNavigate={vi.fn()}
        signupMethods={signupCapabilities.signup.methods}
      />,
    )

    await screen.findByText('[필수] 서비스 이용약관')
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '모두 동의선택 항목에 동의하지 않아도 가입할 수 있어요',
      }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '본인확인으로 계속하기' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '휴대전화 본인확인' }),
    )

    expect(
      await screen.findByRole('heading', { name: '계정 준비를 마쳤어요' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '서비스로 이동' }))

    expect(onAuthenticated).toHaveBeenCalledWith('/dashboard')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('withdraws optional consent when signup returns to the consent step', async () => {
    const submittedDecisions: unknown[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/legal-documents/current')) {
          return jsonResponse({ documents })
        }
        if (url.includes('/signup/consents')) {
          submittedDecisions.push(JSON.parse(String(init?.body)).decisions)
          return jsonResponse({
            status: 'accepted',
            nextStep: 'identity_verification',
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )

    render(
      <OnboardingFlow
        initialScreen="consent"
        onAuthenticated={vi.fn()}
        onExit={vi.fn()}
        onLogin={vi.fn()}
        onNavigate={vi.fn()}
        signupMethods={signupCapabilities.signup.methods}
      />,
    )

    await screen.findByText('[필수] 서비스 이용약관')
    fireEvent.click(
      screen.getByRole('checkbox', {
        name: '모두 동의선택 항목에 동의하지 않아도 가입할 수 있어요',
      }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '본인확인으로 계속하기' }),
    )
    await screen.findByRole('heading', {
      name: '안전한 이용을 위해 본인확인이 필요해요',
    })
    fireEvent.click(screen.getByRole('button', { name: '이전으로' }))

    await screen.findByText('[필수] 서비스 이용약관')
    for (const name of [
      '서비스 이용약관',
      '개인정보 수집·이용 안내',
      '본인확인 정보 처리 안내',
    ]) {
      fireEvent.click(screen.getByRole('checkbox', { name: new RegExp(name) }))
    }
    expect(
      screen.getByRole('checkbox', {
        name: /서비스 소식 및 마케팅 정보 수신/,
      }),
    ).not.toBeChecked()
    fireEvent.click(
      screen.getByRole('button', { name: '본인확인으로 계속하기' }),
    )

    await waitFor(() => expect(submittedDecisions).toHaveLength(2))
    expect(submittedDecisions[0]).toEqual(
      documents.map(({ id }) => ({
        legalDocumentId: id,
        action: 'accepted',
      })),
    )
    expect(submittedDecisions[1]).toEqual(
      documents.map(({ id, required }) => ({
        legalDocumentId: id,
        action: required ? 'accepted' : 'withdrawn',
      })),
    )
  })

  it('fails closed for signup when capability lookup fails while keeping login usable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('capability unavailable')))
    render(<App />)

    fireEvent.click((await screen.findAllByRole('button', { name: '시작하기' }))[0]!)
    const unavailableSignup = screen.getByRole('button', {
      name: /^회원가입 준비 중/,
    })
    expect(unavailableSignup).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /^로그인/ }))
    expect(await screen.findByRole('heading', { name: '로그인' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '이메일로 로그인' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '계정 만들기' })).not.toBeInTheDocument()
    expect(screen.getByText('새 계정 가입은 준비 중입니다. 기존 계정으로 로그인해 주세요.')).toBeInTheDocument()
  })

  it('renders only signup methods returned by the server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/auth/capabilities')) {
          return jsonResponse({
            signup: {
              enabled: true,
              methods: { email: false, oauthProviders: ['naver'] },
            },
          })
        }
        throw new Error(`Unexpected request: ${String(input)}`)
      }),
    )
    render(<App />)

    await openSignupMethodsFromLanding()
    expect(screen.getByRole('button', { name: '네이버로 시작하기' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '카카오로 시작하기' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '구글로 시작하기' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '이메일로 가입하기' })).not.toBeInTheDocument()
  })
})
