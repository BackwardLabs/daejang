import { lazy, Suspense, useCallback, useState } from 'react'
import {
  sourceMethodBullets,
  sourceMethodDefinitions,
  type SourceMethodDefinition,
} from './sourceDefinitions.ts'
import { AppLink } from '../../components/AppLink.tsx'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import { useSourceCapabilities } from './useSourceCapabilities.ts'

const loadReownWalletFlow = () =>
  import('./ReownEvmWalletConnectionRoute.tsx')

const DirectReownWalletFlow = lazy(async () => {
  const module = await loadReownWalletFlow()

  return { default: module.ReownEvmWalletConnectionRoute }
})

function preloadReownWalletFlow() {
  void loadReownWalletFlow().catch(() => undefined)
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
        <strong>{disabled ? '현재 등록 불가' : method.noticeTitle}</strong>
        <span>
          {disabled
            ? '안전한 문서 처리 경로가 활성화된 뒤 등록할 수 있습니다.'
            : method.noticeBody}
        </span>
      </div>
      {disabled ? (
        <span className="source-primary-action" aria-disabled="true">
          Upbit PDF 등록 불가
        </span>
      ) : method.id === 'evm-wallet' ? (
        <button
          className="source-primary-action"
          type="button"
          onClick={onSelect}
          onFocus={preloadReownWalletFlow}
          onPointerEnter={preloadReownWalletFlow}
        >
          EVM Wallet 선택
          <span aria-hidden="true">→</span>
        </button>
      ) : (
        <AppLink className="source-primary-action" href={method.href}>
          Upbit PDF 선택
          <span aria-hidden="true">→</span>
        </AppLink>
      )}
    </article>
  )
}

function SourceTypeSelectionView({
  onWalletSelect,
  walletError,
}: {
  onWalletSelect: () => void
  walletError: string
}) {
  const capabilities = useSourceCapabilities()

  return (
    <SourceFlowLayout
      description="연결할 데이터의 출처와 방식을 선택하세요."
      title="데이터 소스 추가"
    >
      <div className="source-mvp-guide" role="note">
        <span>
          Upbit는 PDF 업로드, EVM은 브라우저 지갑의 읽기 전용 연결 방식으로
          등록합니다.
        </span>
      </div>

      {walletError ? (
        <div className="source-api-notice" role="alert">
          {walletError}
        </div>
      ) : null}

      <section className="source-method-grid" aria-label="데이터 소스 연결 방식">
        <SourceMethodCard
          disabled={!capabilities.upbitPdf.registrationEnabled}
          method={sourceMethodDefinitions['upbit-pdf']}
        />
        <SourceMethodCard
          method={sourceMethodDefinitions['evm-wallet']}
          onSelect={onWalletSelect}
        />
      </section>

      <p className="source-footer-note source-footer-note--after-methods">
        두 방식 모두 수집 범위를 확인한 뒤 최초 수집 작업을 시작합니다.
      </p>
    </SourceFlowLayout>
  )
}

export function SourceTypeSelectionPage() {
  const [launchWallet, setLaunchWallet] = useState(false)
  const [walletError, setWalletError] = useState('')

  const returnToSelection = useCallback(() => {
    setLaunchWallet(false)
  }, [])
  const handleLaunchFailed = useCallback(() => {
    setWalletError(
      '지갑 연결이 취소되었거나 모듈을 열지 못했습니다. 다시 선택해 주세요.',
    )
    setLaunchWallet(false)
  }, [])
  const selectionView = (
    <SourceTypeSelectionView
      walletError={walletError}
      onWalletSelect={() => {
        setWalletError('')
        setLaunchWallet(true)
      }}
    />
  )

  if (!launchWallet) {
    return selectionView
  }

  return (
    <Suspense fallback={selectionView}>
      <DirectReownWalletFlow
        launchImmediately
        pendingView={selectionView}
        onExitRequested={returnToSelection}
        onLaunchFailed={handleLaunchFailed}
      />
    </Suspense>
  )
}
