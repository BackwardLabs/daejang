import { lazy, Suspense, useCallback, useState } from 'react'
import { navigateTo } from '../../auth/navigation.ts'
import {
  sourceMethodBullets,
  sourceMethodDefinitions,
  type SourceMethodId,
} from './sourceDefinitions.ts'
import { AppLink } from '../../components/AppLink.tsx'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import { useSourceCapabilities } from './useSourceCapabilities.ts'
import { queueWalletRegistrationNotice } from './sourceRegistrationNotice.ts'

type WalletFeedback = {
  message: string
}

const loadReownWalletConnection = () =>
  import('./ReownEvmWalletConnectionRoute.tsx')

const ReownWalletLauncher = lazy(async () => {
  const module = await loadReownWalletConnection()

  return { default: module.ReownWalletLauncher }
})

function preloadReownWalletConnection() {
  void loadReownWalletConnection().catch(() => undefined)
}

export function SourceMethodIntroPage({
  methodId,
}: {
  methodId: SourceMethodId
}) {
  const capabilities = useSourceCapabilities()
  const [walletFlowStarted, setWalletFlowStarted] = useState(false)
  const [walletLauncherAttempt, setWalletLauncherAttempt] = useState(0)
  const [walletFeedback, setWalletFeedback] = useState<WalletFeedback>()
  const method = sourceMethodDefinitions[methodId]
  const isUpbitPdf = methodId === 'upbit-pdf'
  const registrationEnabled =
    !isUpbitPdf || capabilities.upbitPdf.registrationEnabled
  const actionLabel =
    isUpbitPdf ? 'PDF 등록 시작' : '지갑 연결 시작'
  const handleWalletConnected = useCallback(() => {
    setWalletFlowStarted(false)
    queueWalletRegistrationNotice()
    navigateTo('/sources')
  }, [])
  const handleWalletCancelled = useCallback(() => {
    setWalletFlowStarted(false)
    setWalletFeedback({
      message: '지갑 연결 또는 서명이 취소되었습니다. 다시 시도해 주세요.',
    })
  }, [])
  const handleWalletError = useCallback(() => {
    setWalletFlowStarted(false)
    setWalletFeedback({
      message: '지갑 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    })
  }, [])

  return (
    <SourceFlowLayout
      badge={
        isUpbitPdf
          ? { label: method.intro.badge, tone: method.tone }
          : undefined
      }
      description={method.intro.subtitle}
      eyebrow={method.intro.eyebrow}
      title={methodId === 'upbit-pdf' ? 'Upbit PDF 등록' : 'EVM Wallet 연결'}
    >
      <section
        className={`source-intro-card source-intro-card--${method.tone}`}
      >
        <div className="source-intro-card__content">
          <header>
            <img src={method.logo} alt="" />
            <span>{method.badge}</span>
          </header>
          <h2>{method.intro.title}</h2>
          <p>{method.intro.description}</p>

          <div className="source-intro-standards">
            <h3>{method.intro.standardsLabel}</h3>
            <ul>
              {method.bullets.map((bullet) => (
                <li key={bullet}>
                  <img src={sourceMethodBullets[method.tone]} alt="" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="source-intro-notice" role="note">
            <strong>{method.intro.noticeTitle}</strong>
            <span>{method.intro.noticeBody}</span>
          </div>

          <div className="source-intro-actions">
            {registrationEnabled ? (
              isUpbitPdf ? (
                <AppLink
                  className="source-primary-action"
                  href="/sources/new/upbit/upload"
                >
                  {actionLabel} <span aria-hidden="true">→</span>
                </AppLink>
              ) : (
                <button
                  type="button"
                  className="source-primary-action"
                  onClick={() => {
                    setWalletFeedback(undefined)
                    setWalletLauncherAttempt((attempt) => attempt + 1)
                    setWalletFlowStarted(true)
                  }}
                  onFocus={preloadReownWalletConnection}
                  onPointerEnter={preloadReownWalletConnection}
                >
                  {actionLabel} <span aria-hidden="true">→</span>
                </button>
              )
            ) : (
              <span className="source-primary-action" aria-disabled="true">
                Upbit PDF 등록 불가
              </span>
            )}
            <AppLink href="/sources/new">
              <span aria-hidden="true">←</span> 연결 방식 다시 선택
            </AppLink>
          </div>
        </div>

        <aside className="source-intro-summary" aria-label={`${method.title} 등록 흐름`}>
          <h2>등록 흐름</h2>
          <ol>
            {method.intro.steps.map((step, index) => (
              <li key={step.label}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <strong>보안 원칙</strong>
            <p>
              {isUpbitPdf
                ? '파일 암호는 격리 파서 처리에만 일회성으로 사용하고 로그·DB·파일에 저장하지 않으며, 거래소 계정 자격증명은 요청하지 않습니다.'
                : 'private key·seed phrase·쓰기·출금 권한을 요청하거나 저장하지 않습니다. 오프체인 서명은 지갑 소유권 확인에만 사용합니다.'}
            </p>
          </div>
        </aside>
      </section>

      {!registrationEnabled ? (
        <p className="source-api-notice" role="alert">
          현재는 안전한 Upbit 문서 처리 경로가 활성화되지 않아 PDF 등록을 받을 수 없습니다.
        </p>
      ) : null}

      {!isUpbitPdf && walletFeedback ? (
        <p
          className="source-api-notice source-api-notice--error"
          role="alert"
        >
          {walletFeedback.message}
        </p>
      ) : null}

      <p className="source-footer-note">{method.intro.footer}</p>

      {!isUpbitPdf && walletFlowStarted ? (
        <Suspense fallback={null}>
          <ReownWalletLauncher
            key={walletLauncherAttempt}
            onCancelled={handleWalletCancelled}
            onConnected={handleWalletConnected}
            onError={handleWalletError}
          />
        </Suspense>
      ) : null}
    </SourceFlowLayout>
  )
}
