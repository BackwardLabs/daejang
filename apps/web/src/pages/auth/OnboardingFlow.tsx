import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  completeMockIdentityVerification,
  createEmailAccount,
  getCurrentLegalDocuments,
  sendEmailCode,
  startSocialAuth,
  submitSignupConsents,
  verifyEmailCode,
  WebApiError,
  type LegalDocument,
  type SignupMethods,
  type SocialProvider,
} from '../../auth/api.ts'
import type { PublicPath } from '../../auth/navigation.ts'
import { isPasswordValid } from '../../auth/password-policy.ts'
import { LegalDocumentContent } from '../../components/auth/LegalDocumentContent.tsx'
import { PasswordInput } from '../../components/auth/PasswordInput.tsx'
import { AuthShell } from './AuthShell.tsx'
import './auth-pages.css'

export type OnboardingScreen =
  | 'method'
  | 'social'
  | 'email'
  | 'consent'
  | 'identity'
  | 'complete'

type OnboardingFlowProps = {
  initialScreen?: OnboardingScreen
  onAuthenticated: (nextPath: string) => void
  onExit: () => void
  onLogin: () => void
  onNavigate: (path: PublicPath) => void
  signupMethods: SignupMethods
}

const steps = [
  ['계정', '로그인 수단 확인'],
  ['약관', '필수·선택 분리'],
  ['본인확인', '가입자 확인'],
  ['완료', '계정 준비 완료'],
] as const

const providerInfo: Record<
  SocialProvider,
  {
    name: string
    label: string
    icon: string
    identity: string
    requested: string
  }
> = {
  kakao: {
    name: '카카오',
    label: '카카오로 시작하기',
    icon: '/onboarding/kakao.svg',
    identity: '카카오 앱별 회원번호',
    requested: '이메일',
  },
  naver: {
    name: '네이버',
    label: '네이버로 시작하기',
    icon: '/onboarding/naver.svg',
    identity: '네이버 애플리케이션별 고유 id',
    requested: '이메일',
  },
  google: {
    name: 'Google',
    label: '구글로 시작하기',
    icon: '/onboarding/google.svg',
    identity: 'Google 계정의 변경되지 않는 sub',
    requested: '이메일과 이메일 확인 상태',
  },
}

const documentCopy: Record<
  LegalDocument['documentType'],
  {
    title: string
    summary: string
  }
> = {
  terms: {
    title: '서비스 이용약관',
    summary: 'Daejang 서비스 이용에 필요한 기본 조건',
  },
  privacy: {
    title: '개인정보 수집·이용 안내',
    summary: '계정 생성과 로그인에 필요한 정보의 처리 기준',
  },
  identity_verification: {
    title: '본인확인 정보 처리 안내',
    summary: '휴대전화 본인확인 결과를 처리하는 목적과 범위',
  },
  marketing: {
    title: '서비스 소식 및 마케팅 정보 수신',
    summary: '서비스 소식 수신 여부를 선택하는 항목',
  },
}

function stepForScreen(screen: OnboardingScreen) {
  if (screen === 'consent') return 2
  if (screen === 'identity') return 3
  if (screen === 'complete') return 4
  return 1
}

function errorMessage(caught: unknown, fallback: string) {
  return caught instanceof WebApiError ? caught.message : fallback
}

function StepSidebar({ activeStep }: { activeStep: number }) {
  return (
    <aside className="auth-step-sidebar" aria-label="회원가입 단계">
      <p className="auth-eyebrow">DAEJANG ACCOUNT</p>
      <h1>
        흩어진 자산 기록을
        <br />
        한 계정에서 관리해요
      </h1>
      <p>계정, 약관, 본인확인을 순서대로 확인합니다</p>
      <ol>
        {steps.map(([label, detail], index) => {
          const number = index + 1
          const status =
            number < activeStep
              ? 'complete'
              : number === activeStep
                ? 'active'
                : 'pending'
          return (
            <li className={`auth-step auth-step--${status}`} key={label}>
              <span aria-hidden="true">
                {status === 'complete' ? '✓' : String(number).padStart(2, '0')}
              </span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}

function StepBadge({ step, label }: { step: number; label: string }) {
  return <p className="auth-step-badge">{step} / 4 · {label}</p>
}

function Dialog({
  title,
  children,
  onClose,
}: {
  title: string
  children: ReactNode
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab') return

      const controls = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      )
      const first = controls[0]
      const last = controls.at(-1)
      if (!first || !last) return

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [onClose])

  return createPortal(
    <div className="auth-dialog-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="auth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <h2 id="auth-dialog-title">{title}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </header>
        <div className="auth-dialog__body">{children}</div>
        <footer>
          <button className="auth-primary-button" type="button" onClick={onClose}>
            확인
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function MethodScreen({
  onEmail,
  onSocial,
  onLogin,
  signupMethods,
}: {
  onEmail: () => void
  onSocial: (provider: SocialProvider) => void
  onLogin: () => void
  signupMethods: SignupMethods
}) {
  const socialProviders = signupMethods.oauthProviders.filter(
    (provider) => provider in providerInfo,
  )
  const hasSocialProvider = socialProviders.length > 0
  return (
    <article className="auth-card">
      <StepBadge step={1} label="계정" />
      <h2>Daejang 계정 만들기</h2>
      <p className="auth-lead">회원정보를 만들 방법을 선택해 주세요</p>
      <div className="auth-provider-list">
        {socialProviders.map((provider) => {
          const item = providerInfo[provider]
          return (
            <button
              className={`auth-provider auth-provider--${provider}`}
              type="button"
              onClick={() => onSocial(provider)}
              key={provider}
            >
              <span aria-hidden="true">
                <img src={item.icon} alt="" width="24" height="24" />
              </span>
              {item.label}
            </button>
          )
        })}
      </div>
      {hasSocialProvider && signupMethods.email ? <div className="auth-divider"><span>또는</span></div> : null}
      {signupMethods.email ? (
        <button className="auth-secondary-button" type="button" onClick={onEmail}>
          이메일로 가입하기
        </button>
      ) : null}
      {!hasSocialProvider && !signupMethods.email ? (
        <p className="auth-alert auth-alert--error" role="alert">현재 사용할 수 있는 가입 방법이 없습니다.</p>
      ) : null}
      <button className="auth-text-button" type="button" onClick={onLogin}>
        이미 계정이 있나요? <strong>로그인</strong>
      </button>
      <p className="auth-note">
        소셜 가입은 선택한 서비스에서 동의한 회원정보를 받아 Daejang 계정을 만듭니다
      </p>
    </article>
  )
}

function SocialScreen({
  provider,
  onBack,
}: {
  provider: SocialProvider
  onBack: () => void
}) {
  const info = providerInfo[provider]
  return (
    <article className="auth-card">
      <button className="auth-back-button" type="button" onClick={onBack}>
        ← 다른 가입 방법
      </button>
      <StepBadge step={1} label="계정" />
      <h2>{info.name} 회원정보로 가입</h2>
      <p className="auth-lead">
        {info.name}에서 동의한 정보를 받아 Daejang 회원정보와 로그인 수단을 만듭니다
      </p>
      <dl className="auth-detail-list">
        <div>
          <dt>계정을 구분하는 기준</dt>
          <dd>{info.identity}</dd>
        </div>
        <div>
          <dt>제공을 요청하는 정보</dt>
          <dd>{info.requested}</dd>
        </div>
        <div>
          <dt>이용 목적</dt>
          <dd>Daejang 회원정보 생성과 로그인 수단 등록</dd>
        </div>
      </dl>
      <ul className="auth-rule-list">
        <li>하나의 소셜 계정은 하나의 Daejang 계정에만 연결합니다</li>
        <li>이메일이나 이름이 같아도 계정을 자동으로 합치지 않습니다</li>
        <li>추가 연결에는 기존 계정과 새 소셜 계정 인증이 모두 필요합니다</li>
      </ul>
      <button
        className="auth-primary-button"
        type="button"
        onClick={() => startSocialAuth(provider, 'signup')}
      >
        {info.name} 로그인 화면으로 이동
      </button>
      <button className="auth-secondary-button" type="button" onClick={onBack}>
        다른 가입 방법 선택
      </button>
    </article>
  )
}

function EmailScreen({ onComplete, onBack }: {
  onComplete: () => void
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [verificationToken, setVerificationToken] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [expiresAt, setExpiresAt] = useState(0)
  const [remaining, setRemaining] = useState(0)
  const [busy, setBusy] = useState<'send' | 'verify' | 'signup' | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!expiresAt) return
    const tick = () => setRemaining(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])

  const sendCode = async () => {
    setBusy('send')
    setError('')
    setMessage('')
    try {
      const response = await sendEmailCode(email.trim())
      setExpiresAt(Date.now() + response.expiresInSeconds * 1000)
      setCode('')
      setVerificationToken('')
      setMessage('인증번호를 보냈습니다')
    } catch (caught) {
      setError(errorMessage(caught, '인증번호를 보내지 못했습니다'))
    } finally {
      setBusy(null)
    }
  }

  const verifyCode = async () => {
    setBusy('verify')
    setError('')
    try {
      const response = await verifyEmailCode(email.trim(), code)
      setVerificationToken(response.verificationToken)
      setMessage('이메일 확인을 완료했습니다')
    } catch (caught) {
      setError(errorMessage(caught, '인증번호를 확인하지 못했습니다'))
    } finally {
      setBusy(null)
    }
  }

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!isPasswordValid(password)) {
      setError('비밀번호 요건을 모두 충족해 주세요')
      return
    }
    if (password !== confirmation) {
      setError('비밀번호가 일치하지 않습니다')
      return
    }
    setBusy('signup')
    setError('')
    try {
      await createEmailAccount({
        email: email.trim(),
        password,
        passwordConfirmation: confirmation,
        verificationToken,
      })
      onComplete()
    } catch (caught) {
      setError(errorMessage(caught, '계정을 만들지 못했습니다'))
    } finally {
      setBusy(null)
    }
  }

  const minutes = String(Math.floor(remaining / 60)).padStart(2, '0')
  const seconds = String(remaining % 60).padStart(2, '0')
  const codeSent = expiresAt > 0

  return (
    <article className="auth-card">
      <button className="auth-back-button" type="button" onClick={onBack}>
        ← 다른 가입 방법
      </button>
      <StepBadge step={1} label="계정" />
      <h2>이메일 계정 만들기</h2>
      <p className="auth-lead">이메일을 확인하고 안전한 비밀번호를 설정해 주세요</p>
      <form className="auth-form" onSubmit={createAccount}>
        <div className="auth-field">
          <label htmlFor="signup-email">이메일 주소</label>
          <div className="auth-action-row">
            <input
              id="signup-email"
              type="email"
              autoComplete="email"
              required
              readOnly={Boolean(verificationToken)}
              placeholder="name@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setError('')
              }}
            />
            <button
              type="button"
              disabled={busy !== null || !email || Boolean(verificationToken)}
              onClick={sendCode}
            >
              {busy === 'send' ? '전송 중' : codeSent ? '다시 보내기' : '인증번호 보내기'}
            </button>
          </div>
        </div>
        {codeSent ? (
          <div className="auth-field">
            <div className="auth-label-row">
              <label htmlFor="signup-code">인증번호</label>
              <span>{verificationToken ? '확인 완료' : `남은 시간 ${minutes}:${seconds}`}</span>
            </div>
            <div className="auth-action-row">
              <input
                id="signup-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                readOnly={Boolean(verificationToken)}
                placeholder="6자리 숫자"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  setError('')
                }}
              />
              <button
                type="button"
                disabled={busy !== null || code.length !== 6 || remaining === 0 || Boolean(verificationToken)}
                onClick={verifyCode}
              >
                {busy === 'verify' ? '확인 중' : verificationToken ? '확인됨' : '인증번호 확인'}
              </button>
            </div>
          </div>
        ) : null}
        <PasswordInput
          id="signup-password"
          label="비밀번호"
          autoComplete="new-password"
          required
          placeholder="영문, 숫자, 특수문자를 조합해 8자 이상 입력"
          value={password}
          onChange={(value) => {
            setPassword(value)
            setError('')
          }}
          showRequirements
        />
        <PasswordInput
          id="signup-password-confirm"
          label="비밀번호 확인"
          autoComplete="new-password"
          required
          placeholder="비밀번호 다시 입력"
          value={confirmation}
          onChange={(value) => {
            setConfirmation(value)
            setError('')
          }}
          aria-invalid={Boolean(confirmation) && password !== confirmation}
        />
        {message ? <p className="auth-alert auth-alert--success" role="status">{message}</p> : null}
        {error ? <p className="auth-alert auth-alert--error" role="alert">{error}</p> : null}
        <button
          className="auth-primary-button"
          type="submit"
          disabled={!verificationToken || busy !== null}
        >
          {busy === 'signup' ? '계정 만드는 중' : '약관 확인하기'}
        </button>
      </form>
    </article>
  )
}

function ConsentScreen({ onComplete, onBack }: {
  onComplete: () => void
  onBack: () => void
}) {
  const [documents, setDocuments] = useState<LegalDocument[]>([])
  const [accepted, setAccepted] = useState<Record<string, boolean>>({})
  const [selectedDocument, setSelectedDocument] = useState<LegalDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const loadDocuments = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getCurrentLegalDocuments()
      setDocuments(response.documents)
    } catch (caught) {
      setError(errorMessage(caught, '약관을 불러오지 못했습니다'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDocuments()
  }, [])

  const requiredAccepted = documents
    .filter(({ required }) => required)
    .every(({ id }) => accepted[id])
  const allAccepted =
    documents.length > 0 && documents.every(({ id }) => accepted[id])

  const submit = async () => {
    setSubmitting(true)
    setError('')
    try {
      await submitSignupConsents(
        documents.map(({ id }) => ({
          legalDocumentId: id,
          action: accepted[id] ? ('accepted' as const) : ('withdrawn' as const),
        })),
      )
      onComplete()
    } catch (caught) {
      setError(errorMessage(caught, '동의 내용을 저장하지 못했습니다'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <article className="auth-card">
      <StepBadge step={2} label="약관" />
      <h2>약관과 개인정보 안내</h2>
      <p className="auth-lead">필수 항목과 선택 항목을 나누어 확인해 주세요</p>
      {loading ? <p className="auth-state" role="status">약관을 불러오는 중</p> : null}
      {error && documents.length === 0 ? (
        <div className="auth-state auth-state--error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={loadDocuments}>다시 시도</button>
        </div>
      ) : null}
      {documents.length > 0 ? (
        <>
          <label className="auth-consent auth-consent--all">
            <input
              type="checkbox"
              checked={allAccepted}
              onChange={() => {
                const next = !allAccepted
                setAccepted(Object.fromEntries(documents.map(({ id }) => [id, next])))
              }}
            />
            <span>
              <strong>모두 동의</strong>
              <small>선택 항목에 동의하지 않아도 가입할 수 있어요</small>
            </span>
          </label>
          <div className="auth-consent-list" role="region" aria-label="약관 동의">
            {documents.map((document) => {
              const copy = documentCopy[document.documentType]
              return (
                <div className="auth-consent-row" key={document.id}>
                  <label className="auth-consent">
                    <input
                      type="checkbox"
                      checked={Boolean(accepted[document.id])}
                      onChange={() =>
                        setAccepted((current) => ({
                          ...current,
                          [document.id]: !current[document.id],
                        }))
                      }
                    />
                    <span>
                      <strong>
                        {document.required ? '[필수]' : '[선택]'} {copy.title}
                      </strong>
                      <small>버전 {document.version}</small>
                    </span>
                  </label>
                  <button type="button" onClick={() => setSelectedDocument(document)}>
                    내용 보기
                  </button>
                </div>
              )
            })}
          </div>
          {error ? <p className="auth-alert auth-alert--error" role="alert">{error}</p> : null}
          <button
            className="auth-primary-button"
            type="button"
            disabled={!requiredAccepted || submitting}
            onClick={submit}
          >
            {submitting ? '동의 내용 저장 중' : '본인확인으로 계속하기'}
          </button>
          <button className="auth-secondary-button" type="button" onClick={onBack}>
            이전으로
          </button>
        </>
      ) : null}
      {selectedDocument ? (
        <Dialog
          title={documentCopy[selectedDocument.documentType].title}
          onClose={() => setSelectedDocument(null)}
        >
          <p className="auth-dialog-summary">
            {documentCopy[selectedDocument.documentType].summary}
          </p>
          <LegalDocumentContent
            className="auth-legal-document"
            content={selectedDocument.content}
          />
          <dl className="auth-dialog-metadata">
            <div><dt>문서 버전</dt><dd>{selectedDocument.version}</dd></div>
            <div><dt>시행 시각</dt><dd>{new Date(selectedDocument.effectiveAt).toLocaleDateString('ko-KR')}</dd></div>
          </dl>
        </Dialog>
      ) : null}
    </article>
  )
}

function IdentityScreen({
  onBack,
  onComplete,
}: {
  onBack: () => void
  onComplete: (nextPath: string) => void
}) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const identityVerificationEnabled =
    import.meta.env.DEV &&
    import.meta.env.VITE_DEV_IDENTITY_MOCK_ENABLED === 'true'

  const completeIdentityVerification = async () => {
    if (!identityVerificationEnabled) return
    setSubmitting(true)
    setError('')
    try {
      const response = await completeMockIdentityVerification()
      onComplete(response.nextPath)
    } catch (caught) {
      setError(errorMessage(caught, '본인확인을 완료하지 못했습니다'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <article className="auth-card auth-card--wide">
      <StepBadge step={3} label="본인확인" />
      <h2>안전한 이용을 위해 본인확인이 필요해요</h2>
      <p className="auth-lead">가입자 확인과 계정 보호에 필요한 범위에서 진행합니다</p>
      <div className="auth-reason-grid">
        {[
          ['01', '중복 계정 생성 제한'],
          ['02', '보고서 신청자 연결'],
          ['03', '제출 자료 명의 대조'],
        ].map(([number, label]) => (
          <div key={number}>
            <span>{number}</span>
            <strong>{label}</strong>
          </div>
        ))}
      </div>
      <div className="auth-info-panel">
        <strong>처리 정보 안내</strong>
        <p>
          본인확인 성공 여부, 성년 여부, 이름과 중복가입 방지정보 등
          서비스에 필요한 범위의 정보만 처리합니다
        </p>
        <button type="button" onClick={() => setDialogOpen(true)}>처리 내용 보기</button>
      </div>
      <button
        className="auth-primary-button"
        type="button"
        disabled={!identityVerificationEnabled || submitting}
        onClick={completeIdentityVerification}
      >
        {submitting ? '본인확인 완료 중' : '휴대전화 본인확인'}
      </button>
      {error ? <p className="auth-alert auth-alert--error" role="alert">{error}</p> : null}
      <button className="auth-secondary-button" type="button" onClick={onBack}>이전으로</button>
      {dialogOpen ? (
        <Dialog title="본인확인 처리 정보 안내" onClose={() => setDialogOpen(false)}>
          <p>
            중복 계정을 제한하고 가입자와 보고서 신청자·제출 자료의 명의를
            보조적으로 연결하기 위해 본인확인 결과를 이용합니다
          </p>
          <dl className="auth-dialog-metadata">
            <div><dt>처리 목적</dt><dd>중복 계정 제한, 계정 보호, 제출 자료 명의 대조</dd></div>
            <div><dt>확인 정보</dt><dd>성공 여부와 시각, 성년 여부, 이름, DI</dd></div>
            <div><dt>기본 수집 제외</dt><dd>CI, 전체 생년월일, 휴대전화번호, 주민등록번호 원문</dd></div>
          </dl>
        </Dialog>
      ) : null}
    </article>
  )
}

function CompleteScreen({ onExit }: { onExit: () => void }) {
  return (
    <article className="auth-card auth-card--result">
      <span className="auth-result-icon" aria-hidden="true">✓</span>
      <StepBadge step={4} label="완료" />
      <h2>계정 준비를 마쳤어요</h2>
      <p className="auth-lead">가입에 필요한 단계를 모두 완료했습니다</p>
      <ul className="auth-complete-list">
        <li><span>01</span>로그인 수단 등록</li>
        <li><span>02</span>필수 약관 동의</li>
        <li><span>03</span>휴대전화 본인확인</li>
      </ul>
      <button className="auth-primary-button" type="button" onClick={onExit}>
        서비스로 이동
      </button>
    </article>
  )
}

export function OnboardingFlow({
  initialScreen = 'method',
  onAuthenticated,
  onExit,
  onLogin,
  onNavigate,
  signupMethods,
}: OnboardingFlowProps) {
  const [screen, setScreen] = useState<OnboardingScreen>(initialScreen)
  const [provider, setProvider] = useState<SocialProvider | null>(null)
  const [completionPath, setCompletionPath] = useState('/dashboard')
  const regionRef = useRef<HTMLDivElement>(null)
  const activeStep = useMemo(() => stepForScreen(screen), [screen])

  useEffect(() => {
    regionRef.current?.focus()
  }, [screen])

  const navigate = (path: PublicPath) => {
    if (screen === 'email') setScreen('method')
    onNavigate(path)
  }

  let content: ReactNode
  if (screen === 'social' && provider) {
    content = <SocialScreen provider={provider} onBack={() => setScreen('method')} />
  } else if (screen === 'email') {
    content = (
      <EmailScreen
        onComplete={() => setScreen('consent')}
        onBack={() => setScreen('method')}
      />
    )
  } else if (screen === 'consent') {
    content = (
      <ConsentScreen
        onComplete={() => setScreen('identity')}
        onBack={() => setScreen('method')}
      />
    )
  } else if (screen === 'identity') {
    content = (
      <IdentityScreen
        onBack={() => setScreen('consent')}
        onComplete={(nextPath) => {
          setCompletionPath(nextPath)
          setScreen('complete')
        }}
      />
    )
  } else if (screen === 'complete') {
    content = (
      <CompleteScreen onExit={() => onAuthenticated(completionPath)} />
    )
  } else {
    content = (
      <MethodScreen
        onEmail={() => setScreen('email')}
        onSocial={(selected) => {
          setProvider(selected)
          setScreen('social')
        }}
        onLogin={onLogin}
        signupMethods={signupMethods}
      />
    )
  }

  return (
    <AuthShell
      onHome={
        screen === 'complete'
          ? () => onAuthenticated(completionPath)
          : onExit
      }
      onNavigate={navigate}
      sidebar={<StepSidebar activeStep={activeStep} />}
      headerAction={
        <div className="auth-header-actions">
          <button type="button" className="auth-link-button" onClick={() => navigate('/support')}>
            도움말
          </button>
          <button type="button" className="auth-outline-button" onClick={onLogin}>
            로그인
          </button>
        </div>
      }
    >
      <div
        ref={regionRef}
        className="auth-screen-region"
        role="region"
        aria-label="회원가입"
        tabIndex={-1}
      >
        {content}
      </div>
    </AuthShell>
  )
}
