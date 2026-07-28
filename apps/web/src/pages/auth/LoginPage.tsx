import { useMemo, useState } from 'react'
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

type LoginView = 'method' | 'social' | 'email'

type ProviderInfo = {
  name: string
  buttonLabel: string
  icon: string
  identityLabel: string
}

const providers: Record<SocialProvider, ProviderInfo> = {
  kakao: {
    name: '카카오',
    buttonLabel: '카카오 로그인',
    icon: '/onboarding/kakao.svg',
    identityLabel: '카카오 앱별 회원번호',
  },
  naver: {
    name: '네이버',
    buttonLabel: '네이버로 로그인',
    icon: '/onboarding/naver.svg',
    identityLabel: '네이버 애플리케이션별 고유 id',
  },
  google: {
    name: 'Google',
    buttonLabel: 'Google로 로그인',
    icon: '/onboarding/google.svg',
    identityLabel: 'Google 계정의 변경되지 않는 sub',
  },
}

const authErrorMessages: Record<string, string> = {
  oauth_access_denied: '소셜 로그인이 취소되었습니다',
  invalid_oauth_transaction:
    '로그인 요청이 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요',
  oauth_provider_unavailable: '선택한 로그인 수단을 현재 사용할 수 없습니다',
  oauth_account_not_found: '연결된 Daejang 계정을 찾지 못했습니다',
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
}

export function LoginPage({
  onHome,
  onSignup,
  onNavigate,
  onAuthenticated,
}: LoginPageProps) {
  const [view, setView] = useState<LoginView>('method')
  const [provider, setProvider] = useState<SocialProvider | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(() => readAuthError())
  const selectedProvider = useMemo(
    () => (provider ? providers[provider] : null),
    [provider],
  )

  const reset = () => {
    setEmail('')
    setPassword('')
    setError('')
    setProvider(null)
    setView('method')
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
          ? caught.message
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
        <button className="auth-outline-button" type="button" onClick={onSignup}>
          계정 만들기
        </button>
      }
    >
      <article className="auth-card">
        {view !== 'method' ? (
          <button className="auth-back-button" type="button" onClick={reset}>
            ← 다른 로그인 방법
          </button>
        ) : null}

        <p className="auth-eyebrow">DAEJANG ACCOUNT</p>
        <h1>
          {view === 'email'
            ? '이메일로 로그인'
            : view === 'social' && selectedProvider
              ? `${selectedProvider.name}로 로그인`
              : '로그인'}
        </h1>
        <p className="auth-lead">
          {view === 'email'
            ? '가입한 이메일과 비밀번호를 입력해 주세요'
            : view === 'social'
              ? '소셜 서비스에서 계정을 확인한 뒤 Daejang으로 돌아옵니다'
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
                    onClick={() => {
                      setProvider(key)
                      setView('social')
                    }}
                  >
                    <span aria-hidden="true">
                      <img src={item.icon} alt="" width="24" height="24" />
                    </span>
                    {item.buttonLabel}
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
            <button className="auth-text-button" type="button" onClick={onSignup}>
              계정이 없나요? <strong>계정 만들기</strong>
            </button>
          </>
        ) : null}

        {view === 'social' && provider && selectedProvider ? (
          <>
            <dl className="auth-detail-list">
              <div>
                <dt>계정 확인 기준</dt>
                <dd>{selectedProvider.identityLabel}</dd>
              </div>
              <div>
                <dt>로그인 후 접근</dt>
                <dd>연결된 Daejang 계정의 보고서와 설정</dd>
              </div>
            </dl>
            <p className="auth-note">
              이메일이나 이름이 같다는 이유만으로 다른 계정과 자동으로 합치지 않습니다
            </p>
            <button
              className="auth-primary-button"
              type="button"
              onClick={() => startSocialAuth(provider, 'login')}
            >
              {selectedProvider.name} 로그인 화면으로 이동
            </button>
            <button className="auth-secondary-button" type="button" onClick={reset}>
              다른 로그인 방법 선택
            </button>
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
