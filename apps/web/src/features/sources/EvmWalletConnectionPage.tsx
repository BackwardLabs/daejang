import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react'
import pdfStepComplete from '../../assets/sources/pdf-step-complete.svg'
import coinbaseLogo from '../../assets/sources/wallet/coinbase.svg'
import metamaskLogo from '../../assets/sources/wallet/metamask.svg'
import otherWalletsIcon from '../../assets/sources/wallet/other-wallets.svg'
import rabbyLogo from '../../assets/sources/wallet/rabby.svg'
import stepActive from '../../assets/sources/wallet/step-active.svg'
import stepInactive from '../../assets/sources/wallet/step-inactive.svg'
import walletConnectLogo from '../../assets/sources/wallet/walletconnect.svg'
import { AppLink } from '../../components/AppLink.tsx'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import {
  EVM_WALLET_ALLOWED_TAX_YEARS,
  EVM_WALLET_COVERAGE_END_DATE,
  EVM_WALLET_COVERAGE_START_DATE,
  createEvmWalletIntentKey,
  evmWalletFlowReducer,
  initialEvmWalletFlowState,
  maskEvmAddress,
  validateEvmWalletPeriodDraft,
  type CompleteWalletConnection,
  type ConnectedWallet,
  type ConnectWallet,
  type ConnectWalletResult,
  type EvmWalletCompletionError,
  type EvmWalletConnectionError,
  type EvmWalletFlowError,
  type EvmWalletFlowState,
  type EvmWalletOwnershipError,
  type EvmWalletPeriodDraft,
  type EvmWalletPeriodFieldErrorCode,
  type EvmWalletProviderId,
  type NormalizedEvmWalletPeriod,
  type RequestOwnershipSignature,
  type WalletSyncJobSnapshot,
  type WatchWalletSyncJob,
} from './evmWalletFlow.ts'
import {
  evmWalletNetworkMetadata,
  getEvmWalletNetwork,
} from './evmNetworks.ts'
import './evm-wallet-flow.css'

const walletProviders: ReadonlyArray<{
  icon: string
  id: EvmWalletProviderId
  name: string
}> = [
  { icon: rabbyLogo, id: 'rabby', name: 'Rabby Wallet' },
  { icon: metamaskLogo, id: 'metamask', name: 'MetaMask' },
  {
    icon: walletConnectLogo,
    id: 'walletconnect',
    name: 'WalletConnect (Reown)',
  },
  { icon: coinbaseLogo, id: 'coinbase', name: 'Coinbase Wallet' },
  { icon: otherWalletsIcon, id: 'other', name: 'Other Wallets' },
]

const providerMeta = Object.fromEntries(
  walletProviders.map((provider) => [provider.id, provider]),
) as Record<
  EvmWalletProviderId,
  (typeof walletProviders)[number]
>

const walletSteps = ['지갑 연결', '수집 범위 확인', '연결 완료'] as const

const connectionErrorCopy: Record<
  EvmWalletConnectionError['code'],
  { body: string; title: string }
> = {
  CONNECTION_FAILED: {
    body: '지갑 연결을 완료하지 못했습니다. 지갑 앱과 네트워크 상태를 확인한 뒤 다시 시도해 주세요.',
    title: '지갑을 연결하지 못했어요',
  },
  CONNECTION_REJECTED: {
    body: '지갑에서 연결 요청을 취소했습니다. 준비가 되면 같은 지갑으로 다시 연결할 수 있습니다.',
    title: '지갑 연결이 취소되었어요',
  },
  SOURCE_ALREADY_CONNECTED: {
    body: '연결된 데이터 소스에서 현재 수집 상태와 네트워크 설정을 확인할 수 있습니다.',
    title: '이미 연결된 지갑입니다',
  },
  PROVIDER_UNAVAILABLE: {
    body: '선택한 지갑을 이 브라우저에서 찾을 수 없습니다. 지갑을 설치하거나 다른 연결 방식을 선택해 주세요.',
    title: '선택한 지갑을 사용할 수 없어요',
  },
}

const signatureErrorCopy: Record<
  EvmWalletOwnershipError['code'],
  { body: string; title: string }
> = {
  SIGNATURE_ADDRESS_MISMATCH: {
    body: '연결한 주소와 서명한 주소가 일치하지 않습니다. 같은 지갑 계정을 선택한 뒤 다시 서명해 주세요.',
    title: '서명한 주소가 달라요',
  },
  SIGNATURE_EXPIRED: {
    body: '5분 유효 시간이 지나 서명 요청이 만료되었습니다. 새 요청으로 다시 서명해 주세요.',
    title: '서명 요청이 만료되었어요',
  },
  SIGNATURE_FAILED: {
    body: '서명을 확인하는 동안 일시적인 문제가 발생했습니다. 연결은 유지되며 다시 시도할 수 있습니다.',
    title: '서명을 확인하지 못했어요',
  },
  SIGNATURE_REJECTED: {
    body: '지갑 연결은 유지되며 같은 지갑으로 다시 서명할 수 있습니다. 취소된 요청은 연결 완료로 처리하지 않습니다.',
    title: '서명이 취소되었습니다',
  },
}

const completionErrorCopy: Record<
  Exclude<EvmWalletCompletionError['code'], 'PERIOD_INVALID'>,
  { body: string; title: string }
> = {
  BACKFILL_FAILED: {
    body: '지갑 연결 정보는 유지됩니다. 잠시 후 같은 범위로 최초 수집을 다시 시작해 주세요.',
    title: '최초 수집을 시작하지 못했어요',
  },
  CHAIN_SCOPE_INVALID: {
    body: '거래를 수집할 네트워크를 하나 이상 선택해 주세요.',
    title: '수집 네트워크를 확인해 주세요',
  },
  SOURCE_SAVE_FAILED: {
    body: '지갑과 선택 기간은 이 화면에 유지됩니다. 연결 정보를 저장하도록 다시 시도해 주세요.',
    title: '지갑 연결을 저장하지 못했어요',
  },
}

const periodFieldErrorCopy: Record<
  EvmWalletPeriodFieldErrorCode,
  string
> = {
  AFTER_LATEST_ALLOWED_DATE: '현재 선택할 수 있는 가장 늦은 날짜를 확인해 주세요.',
  EXCEEDS_MAX_PERIOD: '직접 설정 기간은 최대 1년까지 선택할 수 있습니다.',
  INVALID_FORMAT: 'YYYY-MM-DD 형식의 실제 날짜를 입력해 주세요.',
  NOT_ALLOWED: '현재 선택할 수 있는 과세연도를 골라 주세요.',
  REQUIRED: '필수 입력값입니다.',
  START_AFTER_END: '시작일은 종료일보다 늦을 수 없습니다.',
}

function getCurrentStep(state: EvmWalletFlowState) {
  if (state.view === 'complete') {
    return 3
  }

  if (state.view === 'scope') {
    return 2
  }

  return 1
}

function WalletFlowStepper({ currentStep }: { currentStep: number }) {
  return (
    <nav className="wallet-flow-stepper" aria-label="EVM Wallet 연결 단계">
      <ol>
        {walletSteps.map((label, index) => {
          const step = index + 1
          const state =
            step < currentStep
              ? 'complete'
              : step === currentStep
                ? 'active'
                : 'inactive'
          const icon =
            state === 'complete'
              ? pdfStepComplete
              : state === 'active'
                ? stepActive
                : stepInactive

          return (
            <li
              key={label}
              className={`wallet-flow-stepper__item wallet-flow-stepper__item--${state}`}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span className="wallet-flow-stepper__marker">
                <img src={icon} alt="" />
                <span aria-hidden="true">
                  {state === 'complete' ? '✓' : step}
                </span>
              </span>
              <strong>{label}</strong>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function FlowAlertBox({
  body,
  title,
}: {
  body: string
  title?: string
}) {
  return (
    <div className="wallet-flow-alert" role="alert">
      <span className="wallet-flow-alert__icon" aria-hidden="true">
        !
      </span>
      <div>
        {title ? <strong>{title}</strong> : null}
        <p>{body}</p>
      </div>
    </div>
  )
}

function FlowAlert({ error }: { error: EvmWalletFlowError }) {
  const copy =
    error.code === 'PERIOD_INVALID'
      ? {
          body: '표시된 날짜 입력을 확인한 뒤 다시 진행해 주세요.',
          title: '수집 기간을 확인해 주세요',
        }
      : error.code === 'BACKFILL_FAILED' ||
          error.code === 'CHAIN_SCOPE_INVALID' ||
          error.code === 'SOURCE_SAVE_FAILED'
        ? completionErrorCopy[error.code]
        : error.code === 'CONNECTION_FAILED' ||
            error.code === 'CONNECTION_REJECTED' ||
            error.code === 'SOURCE_ALREADY_CONNECTED' ||
            error.code === 'PROVIDER_UNAVAILABLE'
          ? connectionErrorCopy[error.code]
          : signatureErrorCopy[error.code]

  return <FlowAlertBox body={copy.body} title={copy.title} />
}

function SafetyAside() {
  return (
    <aside className="wallet-flow-aside" aria-label="EVM Wallet 연결 안내">
      <section className="wallet-flow-aside__card">
        <h2>연결 전 확인</h2>
        <ul className="wallet-help-list">
          <li>
            <strong>읽기 전용 연결</strong>
            <span>공개된 지갑 주소와 거래만 조회합니다.</span>
          </li>
          <li>
            <strong>자산 이동 불가</strong>
            <span>개인키, 시드 문구, 쓰기·출금 권한을 요청하지 않습니다.</span>
          </li>
          <li>
            <strong>지원 네트워크</strong>
            <span>
              {evmWalletNetworkMetadata
                .map((network) => network.label)
                .join(', ')}
            </span>
          </li>
        </ul>
      </section>
    </aside>
  )
}

function SignatureAside() {
  return (
    <aside className="wallet-flow-aside" aria-label="지갑 서명 안내">
      <section className="wallet-flow-aside__card">
        <h2>서명으로 확인하는 것</h2>
        <ul className="wallet-help-list">
          <li>
            <strong>지갑 소유권</strong>
            <span>현재 연결한 주소를 제어할 수 있는지만 확인합니다.</span>
          </li>
          <li>
            <strong>거래가 아닌 메시지 서명</strong>
            <span>가스비가 들지 않고 자산 이동도 발생하지 않습니다.</span>
          </li>
          <li>
            <strong>권한 저장 안 함</strong>
            <span>서명 후에도 쓰기·출금 권한을 보관하지 않습니다.</span>
          </li>
        </ul>
      </section>
    </aside>
  )
}

function WalletSelectionStep({
  error,
  isConnecting,
  onConnect,
  onProviderChange,
  selectedProvider,
}: {
  error: EvmWalletConnectionError | null
  isConnecting: boolean
  onConnect: () => void
  onProviderChange: (provider: EvmWalletProviderId) => void
  selectedProvider: EvmWalletProviderId | null
}) {
  return (
    <div className="wallet-flow-grid">
      <section className="wallet-flow-card" aria-labelledby="wallet-select-title">
        <header className="wallet-flow-card__heading">
          <h2 id="wallet-select-title" tabIndex={-1}>
            지갑 선택
          </h2>
          <p>
            연결할 지갑을 선택하세요. 다음 단계에서 소유권 확인을 위해
            서명을 요청합니다.
          </p>
        </header>

        {error ? <FlowAlert error={error} /> : null}

        <fieldset className="wallet-provider-fieldset">
          <legend className="sr-only">연결할 지갑</legend>
          {walletProviders.map((provider) => (
            <label className="wallet-provider-option" key={provider.id}>
              <input
                type="radio"
                name="evm-wallet-provider"
                value={provider.id}
                checked={selectedProvider === provider.id}
                disabled={isConnecting}
                onChange={() => onProviderChange(provider.id)}
              />
              <strong>{provider.name}</strong>
              <img src={provider.icon} alt="" />
            </label>
          ))}
        </fieldset>

        <div className="wallet-flow-actions">
          <AppLink className="wallet-flow-secondary-action" href="/sources/new">
            <span aria-hidden="true">←</span> 취소
          </AppLink>
          <button
            type="button"
            className="source-primary-action"
            disabled={!selectedProvider || isConnecting}
            onClick={onConnect}
          >
            {isConnecting ? '지갑 연결 중…' : '지갑 연결'}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>

      <SafetyAside />
    </div>
  )
}

function ConnectedWalletCard({ wallet }: { wallet: ConnectedWallet }) {
  const provider = providerMeta[wallet.provider]

  return (
    <div className="wallet-connected-card">
      <div className="wallet-connected-card__summary">
        <img src={provider.icon} alt="" />
        <div>
          <strong>{provider.name} 연결됨</strong>
          <span>
            {maskEvmAddress(wallet.address)} · {wallet.network}
          </span>
        </div>
        <span className="wallet-connected-card__badge">연결됨</span>
      </div>
      <div className="wallet-signature-request">
        <strong>요청되는 서명</strong>
        <p>GIWA에 이 주소를 읽기 전용 데이터 소스로 등록합니다.</p>
        <p>거래 또는 자산 이동을 승인하지 않습니다.</p>
        <div className="wallet-signature-assurances">
          <span>✓ 가스비 없음</span>
          <span>✓ 거래 승인 없음</span>
          <span>✓ 자산 이동 권한 없음</span>
        </div>
      </div>
      <p className="wallet-signature-expiry">
        서명 요청은 1회만 사용되며 5분 후 만료됩니다.
      </p>
    </div>
  )
}

function OwnershipStep({
  error,
  isSigning,
  onBack,
  onCancelSignature,
  onSign,
  onWalletReminder,
  reminder,
  wallet,
}: {
  error: EvmWalletOwnershipError | null
  isSigning: boolean
  onBack: () => void
  onCancelSignature: () => void
  onSign: () => void
  onWalletReminder: () => void
  reminder: string
  wallet: ConnectedWallet
}) {
  if (isSigning) {
    return (
      <div className="wallet-flow-grid">
        <section className="wallet-flow-card wallet-signature-status" aria-live="polite">
          <span className="wallet-signature-status__spinner" aria-hidden="true" />
          <span className="wallet-signature-status__state">STATE · WAITING</span>
          <h2 tabIndex={-1}>서명 확인 중</h2>
          <p>
            지갑에서 메시지 서명을 완료해 주세요. 연결은 유지되며 서명이
            끝나면 자동으로 수집 범위 설정으로 이동합니다.
          </p>
          <div className="wallet-flow-actions">
            <button
              type="button"
              className="source-primary-action"
              onClick={onWalletReminder}
            >
              지갑 다시 열기
            </button>
            <button
              type="button"
              className="wallet-flow-secondary-action"
              onClick={onCancelSignature}
            >
              취소
            </button>
          </div>
          <span className="sr-only" aria-live="polite">
            {reminder}
          </span>
        </section>
        <SignatureAside />
      </div>
    )
  }

  if (error) {
    const copy = signatureErrorCopy[error.code]
    return (
      <div className="wallet-flow-grid">
        <section className="wallet-flow-card wallet-signature-status">
          <span className="wallet-signature-status__state">
            {error.code === 'SIGNATURE_REJECTED'
              ? 'STATE · REJECTED'
              : 'STATE · ERROR'}
          </span>
          <h2 tabIndex={-1}>{copy.title}</h2>
          <p>{copy.body}</p>
          <div className="wallet-flow-actions">
            <button
              type="button"
              className="source-primary-action"
              onClick={onSign}
            >
              다시 서명하기
            </button>
            <button
              type="button"
              className="wallet-flow-secondary-action"
              onClick={onBack}
            >
              다른 지갑 선택
            </button>
          </div>
        </section>
        <SignatureAside />
      </div>
    )
  }

  return (
    <div className="wallet-flow-grid">
      <section className="wallet-flow-card" aria-labelledby="wallet-sign-title">
        <header className="wallet-flow-card__heading">
          <h2 id="wallet-sign-title" tabIndex={-1}>
            지갑 소유권 확인
          </h2>
          <p>연결된 지갑에서 메시지 서명을 완료해 주세요.</p>
        </header>

        <ConnectedWalletCard wallet={wallet} />

        <div className="wallet-flow-actions">
          <button
            type="button"
            className="wallet-flow-secondary-action"
            onClick={onBack}
          >
            <span aria-hidden="true">←</span> 다른 지갑 선택
          </button>
          <button
            type="button"
            className="source-primary-action"
            onClick={onSign}
          >
            지갑에서 서명하기 <span aria-hidden="true">→</span>
          </button>
        </div>
      </section>

      <SignatureAside />
    </div>
  )
}

function PeriodFieldError({
  code,
  id,
}: {
  code?: EvmWalletPeriodFieldErrorCode
  id: string
}) {
  if (!code) {
    return null
  }

  return (
    <p className="wallet-period-field__error" id={id}>
      {periodFieldErrorCopy[code]}
    </p>
  )
}

function BackfillAside() {
  return (
    <aside className="wallet-flow-aside" aria-label="최초 수집 안내">
      <section className="wallet-flow-aside__card">
        <h2>처음 연결하면</h2>
        <ol className="wallet-help-list wallet-help-list--numbered">
          <li>
            <strong>선택한 기간을 한 번 수집</strong>
            <span>저장한 범위를 하나의 작업으로 처리합니다.</span>
          </li>
          <li>
            <strong>진행 상태를 소스 관리에서 확인</strong>
            <span>대기·처리·완료 상태와 처리 건수를 보여줍니다.</span>
          </li>
          <li>
            <strong>원본 금융 데이터는 공개 체인에 기록하지 않음</strong>
            <span>공개 지갑 주소는 거래 조회에만 사용합니다.</span>
          </li>
        </ol>
      </section>
    </aside>
  )
}

function ScopeStep({
  chainIds,
  error,
  isSubmitting,
  onBack,
  onChainIdsChange,
  onPeriodChange,
  onSubmit,
  period,
  startDateRef,
  taxYearRef,
  wallet,
}: {
  chainIds: string[]
  error: EvmWalletCompletionError | null
  isSubmitting: boolean
  onBack: () => void
  onChainIdsChange: (chainIds: string[]) => void
  onPeriodChange: (period: EvmWalletPeriodDraft) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  period: EvmWalletPeriodDraft
  startDateRef: RefObject<HTMLInputElement | null>
  taxYearRef: RefObject<HTMLSelectElement | null>
  wallet: ConnectedWallet
}) {
  const fieldErrors =
    error?.code === 'PERIOD_INVALID' ? error.fieldErrors : {}
  const endDateRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (fieldErrors.taxYear) {
      taxYearRef.current?.focus()
    } else if (fieldErrors.startDate) {
      startDateRef.current?.focus()
    } else if (fieldErrors.endDate) {
      endDateRef.current?.focus()
    }
  }, [fieldErrors.endDate, fieldErrors.startDate, fieldErrors.taxYear, startDateRef, taxYearRef])

  return (
    <div className="wallet-flow-grid">
      <form
        className="wallet-flow-card"
        aria-labelledby="wallet-scope-title"
        onSubmit={onSubmit}
      >
        <header className="wallet-flow-card__heading">
          <h2 id="wallet-scope-title" tabIndex={-1}>
            연결 및 수집 범위
          </h2>
          <p>연결할 지갑과 사용자가 지정한 최초 수집 범위를 확인하세요.</p>
        </header>

        {error ? <FlowAlert error={error} /> : null}

        <div className="wallet-scope-summary">
          <div>
            <span>연결된 지갑</span>
            <strong>{maskEvmAddress(wallet.address)}</strong>
          </div>
          <div>
            <span>서명 네트워크</span>
            <strong>{wallet.network}</strong>
          </div>
          <div>
            <span>연결 방식</span>
            <strong>{providerMeta[wallet.provider].name}</strong>
          </div>
        </div>

        <fieldset className="wallet-network-panel">
          <legend>수집 네트워크</legend>
          <p>
            지갑을 다시 연결하지 않아도 같은 주소의 공개 거래를 선택한
            네트워크에서 함께 조회합니다.
          </p>
          <div className="wallet-network-options">
            {evmWalletNetworkMetadata.map((network) => (
              <label key={network.chainId}>
                <input
                  type="checkbox"
                  checked={chainIds.includes(network.chainId)}
                  disabled={isSubmitting}
                  onChange={(event) => {
                    const nextChainIds = event.currentTarget.checked
                      ? [...chainIds, network.chainId]
                      : chainIds.filter((chainId) => chainId !== network.chainId)
                    onChainIdsChange(nextChainIds)
                  }}
                />
                <span>{network.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <section className="wallet-period-panel" aria-labelledby="wallet-period-title">
          <header className="wallet-period-panel__heading">
            <div>
              <h3 id="wallet-period-title">수집 기간</h3>
              <p>현재 서비스에서 지원하는 최초 수집 기간입니다.</p>
            </div>
            <span className="wallet-period-panel__sync">
              동기화 · 사용자 요청 시 선택 범위 수집
            </span>
          </header>

          <fieldset className="wallet-period-mode">
            <legend className="sr-only">수집 기간 방식</legend>
            <label>
              <input
                type="radio"
                name="wallet-period-mode"
                checked={period.mode === 'TAX_YEAR'}
                disabled
                onChange={() =>
                  onPeriodChange({ mode: 'TAX_YEAR', taxYear: '2026' })
                }
              />
              과세연도 전체 (준비 중)
            </label>
            <label>
              <input
                type="radio"
                name="wallet-period-mode"
                checked={period.mode === 'CUSTOM'}
                disabled={isSubmitting}
                onChange={() =>
                  onPeriodChange({
                    endDate: EVM_WALLET_COVERAGE_END_DATE,
                    mode: 'CUSTOM',
                    startDate: EVM_WALLET_COVERAGE_START_DATE,
                  })
                }
              />
              직접 기간 설정
            </label>
          </fieldset>

          <div className="wallet-period-fields">
            {period.mode === 'TAX_YEAR' ? (
              <label className="wallet-period-field wallet-period-field--full">
                <span>과세연도</span>
                <select
                  ref={taxYearRef}
                  value={period.taxYear}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(fieldErrors.taxYear)}
                  aria-describedby={
                    fieldErrors.taxYear ? 'wallet-tax-year-error' : undefined
                  }
                  onChange={(event) =>
                    onPeriodChange({
                      mode: 'TAX_YEAR',
                      taxYear: event.currentTarget.value,
                    })
                  }
                >
                  {EVM_WALLET_ALLOWED_TAX_YEARS.map((year) => (
                    <option value={year} key={year}>
                      {year}년
                    </option>
                  ))}
                </select>
                <PeriodFieldError
                  code={fieldErrors.taxYear}
                  id="wallet-tax-year-error"
                />
              </label>
            ) : (
              <>
                <label className="wallet-period-field">
                  <span>시작일</span>
                  <input
                    ref={startDateRef}
                    type="date"
                    value={period.startDate}
                    disabled
                    aria-invalid={Boolean(fieldErrors.startDate)}
                    aria-describedby={
                      fieldErrors.startDate
                        ? 'wallet-start-date-error'
                        : 'wallet-period-help'
                    }
                    onChange={(event) =>
                      onPeriodChange({
                        ...period,
                        startDate: event.currentTarget.value,
                      })
                    }
                  />
                  <PeriodFieldError
                    code={fieldErrors.startDate}
                    id="wallet-start-date-error"
                  />
                </label>
                <label className="wallet-period-field">
                  <span>종료일</span>
                  <input
                    ref={endDateRef}
                    type="date"
                    value={period.endDate}
                    disabled
                    aria-invalid={Boolean(fieldErrors.endDate)}
                    aria-describedby={
                      fieldErrors.endDate
                        ? 'wallet-end-date-error'
                        : 'wallet-period-help'
                    }
                    onChange={(event) =>
                      onPeriodChange({
                        ...period,
                        endDate: event.currentTarget.value,
                      })
                    }
                  />
                  <PeriodFieldError
                    code={fieldErrors.endDate}
                    id="wallet-end-date-error"
                  />
                </label>
                <p className="wallet-period-help" id="wallet-period-help">
                  현재 검증된 범위: {EVM_WALLET_COVERAGE_START_DATE} ~{' '}
                  {EVM_WALLET_COVERAGE_END_DATE}
                </p>
              </>
            )}
          </div>
        </section>

        <div className="wallet-flow-actions">
          <button
            type="button"
            className="wallet-flow-secondary-action"
            disabled={isSubmitting}
            onClick={onBack}
          >
            <span aria-hidden="true">←</span> 이전
          </button>
          <button
            type="submit"
            className="source-primary-action"
            disabled={isSubmitting}
          >
            {isSubmitting ? '연결 저장 중…' : '연결 완료'}
            <span aria-hidden="true">→</span>
          </button>
        </div>
      </form>

      <BackfillAside />
    </div>
  )
}

function formatPeriodLabel(period: NormalizedEvmWalletPeriod) {
  if (period.mode === 'TAX_YEAR') {
    return `${period.taxYear}년`
  }

  return `${period.startDate} ~ ${period.endDate}`
}

function CompletionAside({
  syncStatus,
}: {
  syncStatus: 'BACKFILLING' | 'REGISTERED'
}) {
  return (
    <aside className="wallet-flow-aside" aria-label="연결 이후 안내">
      <section className="wallet-flow-aside__card">
        <h2>{syncStatus === 'BACKFILLING' ? '수집 진행 안내' : '연결 이후 안내'}</h2>
        <ul className="wallet-help-list">
          {syncStatus === 'BACKFILLING' ? (
            <>
              <li>
                <strong>진행 상태</strong>
                <span>소스 관리에서 처리 건수와 최신 상태를 확인할 수 있습니다.</span>
              </li>
              <li>
                <strong>연결 해제</strong>
                <span>새 수집을 중단하며 이미 만든 장부 데이터는 별도로 관리합니다.</span>
              </li>
            </>
          ) : (
            <li>
              <strong>지갑 등록 완료</strong>
              <span>연결된 소스에서 저장한 범위와 상태를 확인할 수 있습니다.</span>
            </li>
          )}
        </ul>
      </section>
    </aside>
  )
}

function CompletionStep({
  addressPreview,
  chainIds,
  jobId,
  jobSnapshot,
  normalizedPeriod,
  onReset,
  syncStatus,
  watchError,
}: {
  addressPreview: string
  chainIds: string[]
  jobId?: string
  jobSnapshot: WalletSyncJobSnapshot | null
  normalizedPeriod: NormalizedEvmWalletPeriod
  onReset: () => void
  syncStatus: 'BACKFILLING' | 'REGISTERED'
  watchError: boolean
}) {
  const isBackfilling = syncStatus === 'BACKFILLING'
  const syncCopy = jobSnapshot?.state === 'SUCCEEDED'
    ? { badge: 'SUCCEEDED', description: '선택한 기간의 수집 작업이 완료됐습니다.', label: '수집 완료' }
    : jobSnapshot?.state === 'FAILED'
      ? { badge: 'FAILED', description: '수집 작업이 실패했습니다. 소스 관리에서 오류를 확인한 뒤 다시 실행해 주세요.', label: '수집 실패' }
      : jobSnapshot?.state === 'RUNNING'
        ? { badge: 'RUNNING', description: '선택한 기간의 거래를 처리하고 있습니다.', label: '거래 수집 중' }
        : jobSnapshot?.state === 'QUEUED'
          ? { badge: 'QUEUED', description: '수집 작업이 실행 순서를 기다리고 있습니다.', label: '수집 대기' }
          : {
              badge: isBackfilling ? 'BACKFILLING' : 'REGISTERED',
              description: isBackfilling
                ? '연결은 완료됐으며 선택한 전체 기간을 처리하고 있습니다.'
                : '처리 엔진이 연결되면 저장한 범위로 거래 수집을 시작합니다.',
              label: isBackfilling ? '선택 기간 수집 중' : '수집 대기',
            }
  return (
    <div className="wallet-flow-grid">
      <section className="wallet-flow-card" aria-labelledby="wallet-complete-title">
        <div className="wallet-completion">
          <div>
            <h2 id="wallet-complete-title" tabIndex={-1}>
              지갑 연결이 완료됐어요
            </h2>
            <p>
              {jobSnapshot?.state === 'SUCCEEDED'
                ? '지갑 연결과 최초 거래 수집을 완료했습니다.'
                : '지갑 주소와 선택한 수집 범위를 저장했습니다.'}
            </p>
          </div>
        </div>

        <div className="wallet-backfill-status" role="status">
          <div>
            <span>현재 동기화 상태</span>
            <strong>{syncCopy.label}</strong>
          </div>
          <b>{syncCopy.badge}</b>
        </div>
        <p className="wallet-signature-expiry">
          {syncCopy.description}
        </p>
        {watchError ? (
          <FlowAlertBox body="동기화 상태를 새로 확인하지 못했습니다. 작업은 서버에서 계속될 수 있습니다." />
        ) : null}
        {jobSnapshot?.state === 'FAILED' && jobSnapshot.failureMessage ? (
          <FlowAlertBox body={jobSnapshot.failureMessage} />
        ) : null}

        <dl className="wallet-completion-details">
          <div>
            <dt>지갑 주소</dt>
            <dd>{addressPreview}</dd>
          </div>
          <div>
            <dt>수집 네트워크</dt>
            <dd>
              {chainIds
                .map((chainId) => getEvmWalletNetwork(chainId)?.label ?? chainId)
                .join(', ')}
            </dd>
          </div>
          <div>
            <dt>수집 기간</dt>
            <dd>{formatPeriodLabel(normalizedPeriod)}</dd>
          </div>
          {jobId ? (
            <div>
              <dt>동기화 작업 ID</dt>
              <dd>{jobId}</dd>
            </div>
          ) : null}
        </dl>

        <div className="wallet-flow-actions">
          <button
            type="button"
            className="wallet-flow-secondary-action"
            onClick={onReset}
          >
            <span aria-hidden="true">←</span> 다른 지갑 연결
          </button>
          <AppLink className="source-primary-action" href={isBackfilling ? '/dashboard' : '/sources'}>
            {isBackfilling ? '수집 진행 상태 보기' : '연결된 소스 보기'}{' '}
            <span aria-hidden="true">→</span>
          </AppLink>
        </div>
      </section>

      <CompletionAside syncStatus={syncStatus} />
    </div>
  )
}

function getPageCopy(state: EvmWalletFlowState) {
  if (state.view === 'complete') {
    return {
      description:
        state.status === 'BACKFILLING'
          ? '지갑이 연결되고 최초 거래 수집이 시작됐습니다.'
          : '지갑 소유권 확인과 데이터 소스 등록을 완료했습니다.',
      title: 'EVM Wallet 연결 완료',
    }
  }

  if (state.view === 'scope') {
    return {
      description:
        '연결할 지갑과 사용자가 지정한 최초 수집 범위를 확인하세요.',
      title: '수집 범위 확인',
    }
  }

  if (state.view === 'ownership') {
    return {
      description:
        '연결된 지갑에서 메시지 서명을 완료해 지갑 소유권을 확인하세요.',
      title: 'EVM Wallet 소유권 확인',
    }
  }

  return {
    description: '연결 방식은 모두 공개 데이터 읽기 전용입니다.',
    title: 'EVM Wallet 연결',
  }
}

export function EvmWalletConnectionPage({
  autoConnectProvider,
  completeConnection,
  connectWallet,
  onExitRequested,
  onInitialConnectionResult,
  requestSignature,
  watchSyncJob,
}: {
  autoConnectProvider?: EvmWalletProviderId
  completeConnection: CompleteWalletConnection
  connectWallet: ConnectWallet
  onExitRequested?: () => void
  onInitialConnectionResult?: (result: ConnectWalletResult) => void
  requestSignature: RequestOwnershipSignature
  watchSyncJob?: WatchWalletSyncJob
}) {
  const [state, dispatch] = useReducer(
    evmWalletFlowReducer,
    autoConnectProvider,
    (provider): EvmWalletFlowState =>
      provider
        ? {
            error: null,
            provider,
            status: 'SELECTING',
            view: 'select',
          }
        : initialEvmWalletFlowState,
  )
  const [signatureReminder, setSignatureReminder] = useState('')
  const [syncJob, setSyncJob] = useState<WalletSyncJobSnapshot | null>(null)
  const [syncWatchError, setSyncWatchError] = useState(false)
  const activeRequestRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const requestPendingRef = useRef(false)
  const stepContentRef = useRef<HTMLDivElement>(null)
  const previousFocusKeyRef = useRef('')
  const autoConnectStartedRef = useRef(false)
  const startDateRef = useRef<HTMLInputElement>(null)
  const taxYearRef = useRef<HTMLSelectElement>(null)
  const currentStep = getCurrentStep(state)
  const pageCopy = getPageCopy(state)
  const focusKey = `${state.view}:${state.status}`
  const completedJobId = state.view === 'complete' ? state.jobId : undefined

  useEffect(() => {
    setSyncJob(null)
    setSyncWatchError(false)
    if (!completedJobId || !watchSyncJob) return

    const controller = new AbortController()
    void watchSyncJob({
      jobId: completedJobId,
      onUpdate: setSyncJob,
      signal: controller.signal,
    }).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setSyncWatchError(true)
      }
    })
    return () => controller.abort()
  }, [completedJobId, watchSyncJob])

  useEffect(
    () => () => {
      activeRequestRef.current += 1
      abortControllerRef.current?.abort()
      requestPendingRef.current = false
    },
    [],
  )

  useEffect(() => {
    if (previousFocusKeyRef.current !== focusKey) {
      stepContentRef.current?.querySelector<HTMLElement>('h2')?.focus()
      previousFocusKeyRef.current = focusKey
    }
  }, [focusKey])

  function startRequest() {
    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    const controller = new AbortController()
    abortControllerRef.current = controller
    requestPendingRef.current = true

    return {
      controller,
      requestId: activeRequestRef.current,
    }
  }

  function finishRequest(requestId: number) {
    if (activeRequestRef.current === requestId) {
      abortControllerRef.current = null
      requestPendingRef.current = false
    }
  }

  function isCurrentRequest(requestId: number, controller: AbortController) {
    return (
      activeRequestRef.current === requestId &&
      !controller.signal.aborted
    )
  }

  async function handleConnect() {
    if (
      state.view !== 'select' ||
      !state.provider ||
      requestPendingRef.current
    ) {
      return
    }

    const provider = state.provider
    const { controller, requestId } = startRequest()
    dispatch({ type: 'CONNECT_STARTED' })

    try {
      const result = await connectWallet({
        provider,
        signal: controller.signal,
      })
      if (!isCurrentRequest(requestId, controller)) {
        return
      }

      if (result.ok) {
        dispatch({ type: 'CONNECT_SUCCEEDED', wallet: result.wallet })
      } else {
        dispatch({ error: result.error, type: 'CONNECT_FAILED' })
      }
      if (autoConnectProvider) {
        onInitialConnectionResult?.(result)
      }
    } catch {
      if (isCurrentRequest(requestId, controller)) {
        const result: ConnectWalletResult = {
          error: { code: 'CONNECTION_FAILED' },
          ok: false,
        }
        dispatch({
          error: result.error,
          type: 'CONNECT_FAILED',
        })
        if (autoConnectProvider) {
          onInitialConnectionResult?.(result)
        }
      }
    } finally {
      finishRequest(requestId)
    }
  }

  async function handleSignature() {
    if (
      state.view !== 'ownership' ||
      state.status === 'SIGNING' ||
      requestPendingRef.current
    ) {
      return
    }

    const wallet = state.wallet
    const { controller, requestId } = startRequest()
    setSignatureReminder('')
    dispatch({ type: 'SIGNATURE_STARTED' })

    try {
      const result = await requestSignature({
        signal: controller.signal,
        wallet,
      })
      if (!isCurrentRequest(requestId, controller)) {
        return
      }

      if (result.ok) {
        dispatch({
          type: 'SIGNATURE_SUCCEEDED',
          verificationId: result.verificationId,
        })
      } else {
        dispatch({ error: result.error, type: 'SIGNATURE_FAILED' })
      }
    } catch {
      if (isCurrentRequest(requestId, controller)) {
        dispatch({
          error: { code: 'SIGNATURE_FAILED' },
          type: 'SIGNATURE_FAILED',
        })
      }
    } finally {
      finishRequest(requestId)
    }
  }

  function handleCancelSignature() {
    if (state.view !== 'ownership' || state.status !== 'SIGNING') {
      return
    }

    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    requestPendingRef.current = false
    dispatch({
      error: { code: 'SIGNATURE_REJECTED' },
      type: 'SIGNATURE_FAILED',
    })
  }

  async function handleScopeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (
      state.view !== 'scope' ||
      state.status !== 'EDITING' ||
      requestPendingRef.current
    ) {
      return
    }

    const validationError = validateEvmWalletPeriodDraft(state.period)
    const intentKey = state.intentKey ?? createEvmWalletIntentKey()
    dispatch({ intentKey, type: 'SCOPE_SUBMIT_STARTED' })
    if (validationError) {
      return
    }

    const request = {
      chainIds: state.chainIds,
      intentKey,
      period: state.period,
      verificationId: state.verificationId,
      wallet: state.wallet,
    }
    const { controller, requestId } = startRequest()

    try {
      const result = await completeConnection({
        ...request,
        signal: controller.signal,
      })
      if (!isCurrentRequest(requestId, controller)) {
        return
      }

      if (result.ok) {
        dispatch({ result, type: 'SCOPE_SUBMIT_SUCCEEDED' })
      } else {
        dispatch({ error: result.error, type: 'SCOPE_SUBMIT_FAILED' })
      }
    } catch {
      if (isCurrentRequest(requestId, controller)) {
        dispatch({
          error: { code: 'BACKFILL_FAILED' },
          type: 'SCOPE_SUBMIT_FAILED',
        })
      }
    } finally {
      finishRequest(requestId)
    }
  }

  function handleBack() {
    if (autoConnectProvider && state.view === 'ownership') {
      onExitRequested?.()
      return
    }

    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    requestPendingRef.current = false
    dispatch({ type: 'BACK_REQUESTED' })
  }

  useEffect(() => {
    if (!autoConnectProvider || autoConnectStartedRef.current) {
      return
    }

    autoConnectStartedRef.current = true
    void handleConnect()
  }, [autoConnectProvider])

  return (
    <SourceFlowLayout
      description={pageCopy.description}
      eyebrow="DATA SOURCES · EVM"
      title={pageCopy.title}
    >
      <WalletFlowStepper currentStep={currentStep} />

      <div ref={stepContentRef}>
        {state.view === 'select' ? (
          <WalletSelectionStep
            error={state.error}
            isConnecting={false}
            selectedProvider={state.provider}
            onConnect={handleConnect}
            onProviderChange={(provider) =>
              dispatch({ provider, type: 'PROVIDER_SELECTED' })
            }
          />
        ) : null}

        {state.view === 'connect' ? (
          <WalletSelectionStep
            error={null}
            isConnecting
            selectedProvider={state.provider}
            onConnect={() => undefined}
            onProviderChange={() => undefined}
          />
        ) : null}

        {state.view === 'ownership' ? (
          <OwnershipStep
            error={
              state.status === 'FAILED' || state.status === 'REJECTED'
                ? state.error
                : null
            }
            isSigning={state.status === 'SIGNING'}
            reminder={signatureReminder}
            wallet={state.wallet}
            onBack={handleBack}
            onCancelSignature={handleCancelSignature}
            onSign={handleSignature}
            onWalletReminder={() =>
              setSignatureReminder(
                `연결된 ${providerMeta[state.wallet.provider].name}에서 대기 중인 서명 요청을 확인해 주세요.`,
              )
            }
          />
        ) : null}

        {state.view === 'scope' ? (
          <ScopeStep
            chainIds={state.chainIds}
            error={state.status === 'EDITING' ? state.error : null}
            isSubmitting={state.status === 'SUBMITTING'}
            period={state.period}
            startDateRef={startDateRef}
            taxYearRef={taxYearRef}
            wallet={state.wallet}
            onBack={handleBack}
            onChainIdsChange={(chainIds) =>
              dispatch({ chainIds, type: 'CHAIN_SCOPES_CHANGED' })
            }
            onPeriodChange={(period) =>
              dispatch({ period, type: 'PERIOD_CHANGED' })
            }
            onSubmit={handleScopeSubmit}
          />
        ) : null}

        {state.view === 'complete' ? (
          <CompletionStep
            addressPreview={state.addressPreview}
            chainIds={state.chainIds}
            jobId={state.jobId}
            jobSnapshot={syncJob}
            normalizedPeriod={state.normalizedPeriod}
            onReset={() => {
              if (autoConnectProvider) {
                onExitRequested?.()
                return
              }
              dispatch({ type: 'RESET' })
            }}
            syncStatus={state.status}
            watchError={syncWatchError}
          />
        ) : null}
      </div>

    </SourceFlowLayout>
  )
}
