import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  loginWithEmail,
  startSocialAuth,
  WebApiError,
  type SocialProvider,
} from '../../auth/api.ts'
import type { PublicPath } from '../../auth/navigation.ts'
import { PasswordInput } from '../../components/auth/PasswordInput.tsx'
import { AuthShell } from './AuthShell.tsx'
import './auth-pages.css'

type LoginView = 'method' | 'email'

type ProviderInfo = {
  name: string
  buttonLabel: string
  icon: string
}

const providers: Record<SocialProvider, ProviderInfo> = {
  kakao: {
    name: '카카오',
    buttonLabel: '카카오 로그인',
    icon: '/onboarding/kakao.svg',
  },
  naver: {
    name: '네이버',
    buttonLabel: '네이버로 로그인',
    icon: '/onboarding/naver.svg',
  },
  google: {
    name: 'Google',
    buttonLabel: 'Google로 로그인',
    icon: '/onboarding/google.svg',
  },
}

const authErrorMessages: Record<string, string> = {
  oauth_access_denied: '소셜 로그인이 취소되었습니다',
  invalid_oauth_transaction:
    '로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요',
  oauth_provider_unavailable: '선택한 로그인 수단을 현재 사용할 수 없습니다',
  oauth_account_not_found: '연결된 Daejang 계정을 찾지 못했습니다',
  signup_unavailable:
    '현재 신규 가입을 받을 수 없습니다. 기존 계정으로 로그인해 주세요',
  account_already_exists: '이미 가입된 계정입니다. 로그인해 주세요',
  account_unavailable: '현재 이 계정으로 로그인할 수 없습니다',
  oauth_callback_failed: '소셜 서비스에서 계정을 확인하지 못했습니다',
}

function readAuthError() {
  const code = new URL(window.location.href).searchParams.get('auth_error')
  if (!code) return ''
  return authErrorMessages[code] || '로그인을 완료하지 못했습니다. 다시 시도해 주세요'
}

type LoginPageProps = {
  onHome: () => void
  onSignup: () => void
  onNavigate: (path: PublicPath) => void
  onAuthenticated: (nextPath: string) => void
  signupAvailable: boolean
}

export function LoginPage({
  onHome,
  onSignup,
  onNavigate,
  onAuthenticated,
  signupAvailable,
}: LoginPageProps) {
  const [view, setView] = useState<LoginView>('method')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [redirectingProvider, setRedirectingProvider] =
    useState<SocialProvider | null>(null)
  const [error, setError] = useState(() => readAuthError())
  const socialRedirectStartedRef = useRef(false)

  const reset = () => {
    setEmail('')
    setPassword('')
    setError('')
    socialRedirectStartedRef.current = false
    setRedirectingProvider(null)
    setView('method')
  }

  const redirectToSocialLogin = (provider: SocialProvider) => {
    if (socialRedirectStartedRef.current) return

    socialRedirectStartedRef.current = true
    setRedirectingProvider(provider)
    startSocialAuth(provider, 'login')
  }

  const submitEmailLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const response = await loginWithEmail({ email: email.trim(), password })
      onAuthenticated(response.nextPath)
    } catch (caught) {
      setError(
        caught instanceof WebApiError
          ? caught.message.replace(/\.$/u, '')
          : '로그인 요청을 처리하지 못했습니다',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      onHome={onHome}
      onNavigate={onNavigate}
      headerAction={
        signupAvailable ? (
          <button className="auth-outline-button" type="button" onClick={onSignup}>
            계정 만들기
          </button>
        ) : undefined
      }
    >
      <article className="auth-card">
        {view !== 'method' ? (
          <button className="auth-back-button" type="button" onClick={reset}>
            ← 다른 로그인 방법
          </button>
        ) : null}

        <p className="auth-eyebrow">DAEJANG ACCOUNT</p>
        <h1>{view === 'email' ? '이메일로 로그인' : '로그인'}</h1>
        <p className="auth-lead">
          {view === 'email'
            ? '가입한 이메일과 비밀번호를 입력해 주세요'
            : '사용할 로그인 수단을 선택해 주세요'}
        </p>

        {view === 'method' ? (
          <>
            {error ? <p className="auth-alert auth-alert--error" role="alert">{error}</p> : null}
            <div className="auth-provider-list">
              {(Object.keys(providers) as SocialProvider[]).map((key) => {
                const item = providers[key]
                return (
                  <button
                    className={`auth-provider auth-provider--${key}`}
                    type="button"
                    key={key}
                    disabled={redirectingProvider !== null}
                    onClick={() => redirectToSocialLogin(key)}
                  >
                    <span aria-hidden="true">
                      <img src={item.icon} alt="" width="24" height="24" />
                    </span>
                    {redirectingProvider === key
                      ? `${item.name}로 이동 중`
                      : item.buttonLabel}
                  </button>
                )
              })}
            </div>
            <div className="auth-divider"><span>또는</span></div>
            <button
              className="auth-secondary-button"
              type="button"
              onClick={() => setView('email')}
            >
              이메일로 로그인
            </button>
            {signupAvailable ? (
              <button className="auth-text-button" type="button" onClick={onSignup}>
                계정이 없나요? <strong>계정 만들기</strong>
              </button>
            ) : (
              <p className="auth-note">새 계정 가입은 준비 중입니다. 기존 계정으로 로그인해 주세요.</p>
            )}
          </>
        ) : null}

        {view === 'email' ? (
          <form className="auth-form" onSubmit={submitEmailLogin}>
            <div className="auth-field">
              <label htmlFor="login-email">이메일 주소</label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                placeholder="name@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value)
                  setError('')
                }}
              />
            </div>
            <PasswordInput
              id="login-password"
              label="비밀번호"
              autoComplete="current-password"
              required
              placeholder="비밀번호 입력"
              value={password}
              onChange={(value) => {
                setPassword(value)
                setError('')
              }}
            />
            {error ? <p className="auth-alert auth-alert--error" role="alert">{error}</p> : null}
            <button
              className="auth-primary-button"
              type="submit"
              disabled={submitting}
            >
              {submitting ? '로그인 중' : '로그인'}
            </button>
          </form>
        ) : null}
      </article>
    </AuthShell>
  )
}
