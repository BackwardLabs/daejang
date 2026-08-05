import { EVM_WALLET_SUPPORTED_CHAIN_IDS } from './evmNetworks.ts'

export const EVM_WALLET_PROVIDER_IDS = [
  'rabby',
  'metamask',
  'walletconnect',
  'coinbase',
  'other',
] as const

export type EvmWalletProviderId =
  (typeof EVM_WALLET_PROVIDER_IDS)[number]

export type ConnectedWallet = {
  address: string
  chainId: string
  network: string
  provider: EvmWalletProviderId
}

export type EvmWalletTaxYearPeriodDraft = {
  mode: 'TAX_YEAR'
  taxYear: string
}

export type EvmWalletCustomPeriodDraft = {
  endDate: string
  mode: 'CUSTOM'
  startDate: string
}

export type EvmWalletPeriodDraft =
  | EvmWalletCustomPeriodDraft
  | EvmWalletTaxYearPeriodDraft

export type NormalizedEvmWalletPeriod =
  | {
      endDate: string
      mode: 'TAX_YEAR'
      startDate: string
      taxYear: string
    }
  | {
      endDate: string
      mode: 'CUSTOM'
      startDate: string
    }

export type EvmWalletPeriodField =
  | 'endDate'
  | 'startDate'
  | 'taxYear'

export type EvmWalletPeriodFieldErrorCode =
  | 'AFTER_LATEST_ALLOWED_DATE'
  | 'EXCEEDS_MAX_PERIOD'
  | 'INVALID_FORMAT'
  | 'NOT_ALLOWED'
  | 'REQUIRED'
  | 'START_AFTER_END'

export type EvmWalletPeriodFieldErrors = Partial<
  Record<EvmWalletPeriodField, EvmWalletPeriodFieldErrorCode>
>

export type EvmWalletPeriodInvalidError = {
  code: 'PERIOD_INVALID'
  fieldErrors: EvmWalletPeriodFieldErrors
  requestId?: string
}

export type EvmWalletConnectionError = {
  code:
    | 'CONNECTION_FAILED'
    | 'CONNECTION_REJECTED'
    | 'SOURCE_ALREADY_CONNECTED'
    | 'PROVIDER_UNAVAILABLE'
  requestId?: string
}

export type EvmWalletOwnershipError = {
  code:
    | 'SIGNATURE_ADDRESS_MISMATCH'
    | 'SIGNATURE_EXPIRED'
    | 'SIGNATURE_FAILED'
    | 'SIGNATURE_REJECTED'
  requestId?: string
}

export type EvmWalletCompletionError =
  | EvmWalletPeriodInvalidError
  | {
      code: 'BACKFILL_FAILED' | 'CHAIN_SCOPE_INVALID' | 'SOURCE_SAVE_FAILED'
      requestId?: string
    }

export type EvmWalletFlowError =
  | EvmWalletCompletionError
  | EvmWalletConnectionError
  | EvmWalletOwnershipError

export type WalletSyncJobState =
  | 'FAILED'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'

export type WalletSyncJobSnapshot = {
  attempts: number | string
  failureCode?: string
  failureMessage?: string
  id: string
  processedRecords: number | string
  state: WalletSyncJobState
  updatedAt: string
  ledgerMaterializationState?:
    | 'NO_POSTING'
    | 'PENDING'
    | 'POSTED'
    | 'REVIEW_REQUIRED'
    | 'UNAVAILABLE'
  ledgerPostingCount?: number | string
}

export type WatchWalletSyncJob = (request: {
  jobId: string
  onUpdate: (job: WalletSyncJobSnapshot) => void
  signal: AbortSignal
  waitForLedger?: boolean
}) => Promise<WalletSyncJobSnapshot>

export const EVM_WALLET_ALLOWED_TAX_YEARS = [
  '2027',
  '2026',
] as const
export const EVM_WALLET_LATEST_ALLOWED_DATE = '2027-12-31'
export const EVM_WALLET_COVERAGE_START_DATE = '2026-07-21'
export const EVM_WALLET_COVERAGE_END_DATE = '2026-07-29'
export const DEFAULT_EVM_WALLET_PERIOD: EvmWalletPeriodDraft = {
  endDate: EVM_WALLET_COVERAGE_END_DATE,
  mode: 'CUSTOM',
  startDate: EVM_WALLET_COVERAGE_START_DATE,
}

type SelectState = {
  error: EvmWalletConnectionError | null
  provider: EvmWalletProviderId | null
  status: 'SELECTING'
  view: 'select'
}

type ConnectState = {
  provider: EvmWalletProviderId
  status: 'CONNECTING'
  view: 'connect'
}

type OwnershipReadyState = {
  error: null
  status: 'READY'
  view: 'ownership'
  wallet: ConnectedWallet
}

type OwnershipSigningState = {
  status: 'SIGNING'
  view: 'ownership'
  wallet: ConnectedWallet
}

type OwnershipErrorState = {
  error: EvmWalletOwnershipError
  status: 'FAILED' | 'REJECTED'
  view: 'ownership'
  wallet: ConnectedWallet
}

type ScopeEditingState = {
  chainIds: string[]
  error: EvmWalletCompletionError | null
  intentKey: string | null
  period: EvmWalletPeriodDraft
  status: 'EDITING'
  verificationId: string
  view: 'scope'
  wallet: ConnectedWallet
}

type ScopeSubmittingState = {
  chainIds: string[]
  intentKey: string
  period: EvmWalletPeriodDraft
  status: 'SUBMITTING'
  verificationId: string
  view: 'scope'
  wallet: ConnectedWallet
}

type CompleteState = {
  addressPreview: string
  chainIds: string[]
  jobId?: string
  normalizedPeriod: NormalizedEvmWalletPeriod
  provider: EvmWalletProviderId
  sourceId: string
  sourceStatus: 'SOURCE_SAVED'
  status: 'BACKFILLING' | 'REGISTERED'
  view: 'complete'
}

export type EvmWalletFlowState =
  | CompleteState
  | ConnectState
  | OwnershipErrorState
  | OwnershipReadyState
  | OwnershipSigningState
  | ScopeEditingState
  | ScopeSubmittingState
  | SelectState

export type EvmWalletFlowAction =
  | {
      provider: EvmWalletProviderId
      type: 'PROVIDER_SELECTED'
    }
  | {
      type: 'CONNECT_STARTED'
    }
  | {
      type: 'CONNECT_SUCCEEDED'
      wallet: ConnectedWallet
    }
  | {
      error: EvmWalletConnectionError
      type: 'CONNECT_FAILED'
    }
  | {
      type: 'SIGNATURE_STARTED'
    }
  | {
      type: 'SIGNATURE_SUCCEEDED'
      verificationId: string
    }
  | {
      error: EvmWalletOwnershipError
      type: 'SIGNATURE_FAILED'
    }
  | {
      chainIds: string[]
      type: 'CHAIN_SCOPES_CHANGED'
    }
  | {
      period: EvmWalletPeriodDraft
      type: 'PERIOD_CHANGED'
    }
  | {
      intentKey: string
      type: 'SCOPE_SUBMIT_STARTED'
    }
  | {
      error: EvmWalletCompletionError
      type: 'SCOPE_SUBMIT_FAILED'
    }
  | {
      result: CompleteWalletConnectionSuccess
      type: 'SCOPE_SUBMIT_SUCCEEDED'
    }
  | {
      type: 'BACK_REQUESTED'
    }
  | {
      type: 'RESET'
    }

export const initialEvmWalletFlowState: EvmWalletFlowState = {
  error: null,
  provider: null,
  status: 'SELECTING',
  view: 'select',
}

export function evmWalletFlowReducer(
  state: EvmWalletFlowState,
  action: EvmWalletFlowAction,
): EvmWalletFlowState {
  switch (action.type) {
    case 'PROVIDER_SELECTED':
      if (state.view !== 'select') {
        return state
      }

      return {
        error: null,
        provider: action.provider,
        status: 'SELECTING',
        view: 'select',
      }
    case 'CONNECT_STARTED':
      if (state.view !== 'select' || !state.provider) {
        return state
      }

      return {
        provider: state.provider,
        status: 'CONNECTING',
        view: 'connect',
      }
    case 'CONNECT_SUCCEEDED':
      if (
        state.view !== 'connect' ||
        action.wallet.provider !== state.provider ||
        action.wallet.address.length === 0 ||
        action.wallet.chainId.length === 0 ||
        action.wallet.network.length === 0
      ) {
        return state
      }

      return {
        error: null,
        status: 'READY',
        view: 'ownership',
        wallet: action.wallet,
      }
    case 'CONNECT_FAILED':
      if (state.view !== 'connect') {
        return state
      }

      return {
        error: action.error,
        provider: state.provider,
        status: 'SELECTING',
        view: 'select',
      }
    case 'SIGNATURE_STARTED':
      if (
        state.view !== 'ownership' ||
        state.status === 'SIGNING'
      ) {
        return state
      }

      return {
        status: 'SIGNING',
        view: 'ownership',
        wallet: state.wallet,
      }
    case 'SIGNATURE_SUCCEEDED': {
      const verificationId = action.verificationId.trim()
      if (
        state.view !== 'ownership' ||
        state.status !== 'SIGNING' ||
        verificationId.length === 0
      ) {
        return state
      }

      return {
        chainIds: [...EVM_WALLET_SUPPORTED_CHAIN_IDS],
        error: null,
        intentKey: null,
        period: { ...DEFAULT_EVM_WALLET_PERIOD },
        status: 'EDITING',
        verificationId,
        view: 'scope',
        wallet: state.wallet,
      }
    }
    case 'SIGNATURE_FAILED':
      if (
        state.view !== 'ownership' ||
        state.status !== 'SIGNING'
      ) {
        return state
      }

      return {
        error: action.error,
        status:
          action.error.code === 'SIGNATURE_REJECTED'
            ? 'REJECTED'
            : 'FAILED',
        view: 'ownership',
        wallet: state.wallet,
      }
    case 'PERIOD_CHANGED':
      if (state.view !== 'scope' || state.status !== 'EDITING') {
        return state
      }

      return {
        ...state,
        error: null,
        intentKey: null,
        period: action.period,
      }
    case 'CHAIN_SCOPES_CHANGED':
      if (state.view !== 'scope' || state.status !== 'EDITING') {
        return state
      }

      return {
        ...state,
        chainIds: action.chainIds.filter((chainId) =>
          EVM_WALLET_SUPPORTED_CHAIN_IDS.includes(
            chainId as (typeof EVM_WALLET_SUPPORTED_CHAIN_IDS)[number],
          ),
        ),
        error: null,
        intentKey: null,
      }
    case 'SCOPE_SUBMIT_STARTED': {
      if (
        state.view !== 'scope' ||
        state.status !== 'EDITING'
      ) {
        return state
      }

      const validationError = validateEvmWalletPeriodDraft(
        state.period,
      )
      if (validationError) {
        return {
          ...state,
          error: validationError,
          intentKey: null,
        }
      }

      if (state.chainIds.length === 0) {
        return {
          ...state,
          error: { code: 'CHAIN_SCOPE_INVALID' },
          intentKey: null,
        }
      }

      const intentKey =
        state.intentKey ?? action.intentKey.trim()
      if (intentKey.length === 0) {
        return state
      }

      return {
        chainIds: state.chainIds,
        intentKey,
        period: state.period,
        status: 'SUBMITTING',
        verificationId: state.verificationId,
        view: 'scope',
        wallet: state.wallet,
      }
    }
    case 'SCOPE_SUBMIT_FAILED':
      if (state.view !== 'scope' || state.status !== 'SUBMITTING') {
        return state
      }

      return {
        chainIds: state.chainIds,
        error: action.error,
        intentKey: state.intentKey,
        period: state.period,
        status: 'EDITING',
        verificationId: state.verificationId,
        view: 'scope',
        wallet: state.wallet,
      }
    case 'SCOPE_SUBMIT_SUCCEEDED':
      if (
        state.view !== 'scope' ||
        state.status !== 'SUBMITTING' ||
        action.result.sourceId.length === 0
      ) {
        return state
      }

      return {
        addressPreview: maskEvmAddress(state.wallet.address),
        chainIds: state.chainIds,
        ...(action.result.jobId ? { jobId: action.result.jobId } : {}),
        normalizedPeriod: action.result.normalizedPeriod,
        provider: state.wallet.provider,
        sourceId: action.result.sourceId,
        sourceStatus: action.result.sourceStatus,
        status: action.result.jobStatus,
        view: 'complete',
      }
    case 'BACK_REQUESTED':
      if (state.view === 'connect') {
        return {
          error: null,
          provider: state.provider,
          status: 'SELECTING',
          view: 'select',
        }
      }

      if (
        state.view === 'ownership' &&
        state.status !== 'SIGNING'
      ) {
        return {
          error: null,
          provider: state.wallet.provider,
          status: 'SELECTING',
          view: 'select',
        }
      }

      if (state.view === 'scope' && state.status === 'EDITING') {
        return {
          error: null,
          status: 'READY',
          view: 'ownership',
          wallet: state.wallet,
        }
      }

      return state
    case 'RESET':
      return initialEvmWalletFlowState
  }
}

export function validateEvmWalletPeriodDraft(
  period: EvmWalletPeriodDraft,
): EvmWalletPeriodInvalidError | null {
  const fieldErrors: EvmWalletPeriodFieldErrors = {}

  if (period.mode === 'TAX_YEAR') {
    if (period.taxYear.length === 0) {
      fieldErrors.taxYear = 'REQUIRED'
    } else if (!/^[1-9]\d{3}$/.test(period.taxYear)) {
      fieldErrors.taxYear = 'INVALID_FORMAT'
    } else if (
      !EVM_WALLET_ALLOWED_TAX_YEARS.includes(
        period.taxYear as (typeof EVM_WALLET_ALLOWED_TAX_YEARS)[number],
      )
    ) {
      fieldErrors.taxYear = 'NOT_ALLOWED'
    } else if (
      `${period.taxYear}-12-31` >
      EVM_WALLET_LATEST_ALLOWED_DATE
    ) {
      fieldErrors.taxYear = 'AFTER_LATEST_ALLOWED_DATE'
    }
  } else {
    if (period.startDate.length === 0) {
      fieldErrors.startDate = 'REQUIRED'
    } else if (!isStrictIsoDate(period.startDate)) {
      fieldErrors.startDate = 'INVALID_FORMAT'
    }

    if (period.endDate.length === 0) {
      fieldErrors.endDate = 'REQUIRED'
    } else if (!isStrictIsoDate(period.endDate)) {
      fieldErrors.endDate = 'INVALID_FORMAT'
    }

    if (
      !fieldErrors.startDate &&
      !fieldErrors.endDate &&
      period.startDate > period.endDate
    ) {
      fieldErrors.startDate = 'START_AFTER_END'
      fieldErrors.endDate = 'START_AFTER_END'
    }

    if (!fieldErrors.startDate && !fieldErrors.endDate) {
      if (period.endDate > EVM_WALLET_LATEST_ALLOWED_DATE) {
        fieldErrors.endDate = 'AFTER_LATEST_ALLOWED_DATE'
        if (
          period.startDate > EVM_WALLET_LATEST_ALLOWED_DATE
        ) {
          fieldErrors.startDate = 'AFTER_LATEST_ALLOWED_DATE'
        }
      } else if (
        period.endDate >=
        addOneCalendarYear(period.startDate)
      ) {
        fieldErrors.endDate = 'EXCEEDS_MAX_PERIOD'
      }
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null
  }

  return {
    code: 'PERIOD_INVALID',
    fieldErrors,
  }
}

export function normalizeEvmWalletPeriod(
  period: EvmWalletPeriodDraft,
): NormalizedEvmWalletPeriod {
  if (period.mode === 'TAX_YEAR') {
    return {
      endDate: `${period.taxYear}-12-31`,
      mode: period.mode,
      startDate: `${period.taxYear}-01-01`,
      taxYear: period.taxYear,
    }
  }

  return {
    endDate: period.endDate,
    mode: period.mode,
    startDate: period.startDate,
  }
}

function isStrictIsoDate(value: string) {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return false
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12) {
    return false
  }

  const isLeapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysByMonth = [
    31,
    isLeapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  const daysInMonth = daysByMonth[month - 1]

  return daysInMonth !== undefined && day >= 1 && day <= daysInMonth
}

function addOneCalendarYear(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  const anniversary = new Date(
    Date.UTC((year ?? 0) + 1, (month ?? 1) - 1, day ?? 1),
  )

  return anniversary.toISOString().slice(0, 10)
}

let fallbackIntentSequence = 0

export function createEvmWalletIntentKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  fallbackIntentSequence += 1
  return `evm-wallet-${Date.now()}-${fallbackIntentSequence}`
}

export function maskEvmAddress(address: string) {
  const normalizedAddress = address.trim()
  if (normalizedAddress.length <= 12) {
    return normalizedAddress
  }

  return `${normalizedAddress.slice(0, 6)}…${normalizedAddress.slice(-4)}`
}

export type ConnectWalletRequest = {
  provider: EvmWalletProviderId
  signal: AbortSignal
}

export type ConnectWalletSuccess = {
  ok: true
  wallet: ConnectedWallet
}

export type ConnectWalletResult =
  | ConnectWalletSuccess
  | {
      error: EvmWalletConnectionError
      ok: false
    }

export type ConnectWallet = (
  request: ConnectWalletRequest,
) => Promise<ConnectWalletResult>

export type RequestOwnershipSignatureRequest = {
  signal: AbortSignal
  wallet: ConnectedWallet
}

export type RequestOwnershipSignatureSuccess = {
  ok: true
  verificationId: string
}

export type RequestOwnershipSignatureResult =
  | RequestOwnershipSignatureSuccess
  | {
      error: EvmWalletOwnershipError
      ok: false
    }

export type RequestOwnershipSignature = (
  request: RequestOwnershipSignatureRequest,
) => Promise<RequestOwnershipSignatureResult>

export type CompleteWalletConnectionRequest = {
  chainIds: string[]
  intentKey: string
  period: EvmWalletPeriodDraft
  signal: AbortSignal
  verificationId: string
  wallet: ConnectedWallet
}

export type CompleteWalletConnectionSuccess = {
  jobId?: string
  jobStatus: 'BACKFILLING' | 'REGISTERED'
  normalizedPeriod: NormalizedEvmWalletPeriod
  ok: true
  sourceId: string
  sourceStatus: 'SOURCE_SAVED'
}

export type CompleteWalletConnectionResult =
  | CompleteWalletConnectionSuccess
  | {
      error: EvmWalletCompletionError
      ok: false
    }

export type CompleteWalletConnection = (
  request: CompleteWalletConnectionRequest,
) => Promise<CompleteWalletConnectionResult>
