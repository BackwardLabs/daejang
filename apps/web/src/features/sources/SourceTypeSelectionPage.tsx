import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  sourceMethodBullets,
  sourceMethodDefinitions,
  type SourceMethodDefinition,
} from './sourceDefinitions.ts'
import { AppLink } from '../../components/AppLink.tsx'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import { useSourceCapabilities } from './useSourceCapabilities.ts'

const loadReownEvmWalletConnectionRoute = () =>
  import('./ReownEvmWalletConnectionRoute.tsx')

const ReownEvmWalletConnectionRoute = lazy(() =>
  loadReownEvmWalletConnectionRoute().then((module) => ({
    default: module.ReownEvmWalletConnectionRoute,
  })),
)

function preloadReownEvmWalletConnectionRoute() {
  void loadReownEvmWalletConnectionRoute().catch(() => undefined)
}

function SourceMethodCard({
  disabled = false,
  method,
  onSelect,
}: {
  disabled?: boolean
  method: SourceMethodDefinition
  onSelect?: () => void
}) {
  return (
    <article className={`source-method-card source-method-card--${method.tone}`}>
      <header>
        <img src={method.logo} alt="" />
        <span>{method.badge}</span>
      </header>
      <h2>{method.title}</h2>
      <p>{method.description}</p>
      <ul>
        {method.bullets.map((bullet) => (
          <li key={bullet}>
            <img src={sourceMethodBullets[method.tone]} alt="" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <div className="source-method-card__notice" role="note">
        <strong>{disabled ? '현재 준비 중' : method.noticeTitle}</strong>
        <span>
          {disabled
            ? '안전한 문서 처리 경로가 활성화된 뒤 등록할 수 있습니다.'
            : method.noticeBody}
        </span>
      </div>
      {disabled ? (
        <span className="source-primary-action" aria-disabled="true">
          준비 중
        </span>
      ) : onSelect ? (
        <button
          className="source-primary-action"
          type="button"
          onFocus={preloadReownEvmWalletConnectionRoute}
          onClick={onSelect}
          onPointerEnter={preloadReownEvmWalletConnectionRoute}
        >
          EVM Wallet 선택
          <span aria-hidden="true">→</span>
        </button>
      ) : method.href ? (
        <AppLink className="source-primary-action" href={method.href}>
          Upbit PDF 선택
          <span aria-hidden="true">→</span>
        </AppLink>
      ) : null}
    </article>
  )
}

function SourceTypeSelectionView({
  onEvmWalletSelect,
}: {
  onEvmWalletSelect: () => void
}) {
  const capabilities = useSourceCapabilities()

  return (
    <SourceFlowLayout
      description="연결할 데이터의 출처와 방식을 선택하세요."
      title="데이터 소스 추가"
    >
      <div className="source-mvp-guide" role="note">
        <span>
          Upbit는 거래내역서 등록, EVM은 브라우저 지갑의 읽기 전용 연결 방식으로
          등록합니다.
        </span>
      </div>

      <section className="source-method-grid" aria-label="데이터 소스 연결 방식">
        <SourceMethodCard
          disabled={!capabilities.upbitPdf.registrationEnabled}
          method={sourceMethodDefinitions['upbit-pdf']}
        />
        <SourceMethodCard
          method={sourceMethodDefinitions['evm-wallet']}
          onSelect={onEvmWalletSelect}
        />
      </section>
    </SourceFlowLayout>
  )
}

export function SourceTypeSelectionPage() {
  const [walletFlowActive, setWalletFlowActive] = useState(false)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const selectionView = (
    <SourceTypeSelectionView
      onEvmWalletSelect={() => setWalletFlowActive(true)}
    />
  )

  useEffect(() => {
    if (!walletFlowActive) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButtonRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWalletFlowActive(false)
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [walletFlowActive])

  return (
    <>
      {selectionView}
      {walletFlowActive ? (
        <div className="wallet-connect-overlay">
          <section
            aria-label="지갑 연결"
            aria-modal="true"
            className="wallet-connect-dialog"
            role="dialog"
          >
            <button
              ref={closeButtonRef}
              aria-label="지갑 연결 닫기"
              className="wallet-connect-dialog__close"
              type="button"
              onClick={() => setWalletFlowActive(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
            <Suspense
              fallback={
                <div className="wallet-connect-dialog__loading" role="status">
                  <span aria-hidden="true" />
                  지갑 연결 화면을 준비하고 있어요
                </div>
              }
            >
              <ReownEvmWalletConnectionRoute
                presentation="dialog"
                onExitRequested={() => setWalletFlowActive(false)}
              />
            </Suspense>
          </section>
        </div>
      ) : null}
    </>
  )
}
