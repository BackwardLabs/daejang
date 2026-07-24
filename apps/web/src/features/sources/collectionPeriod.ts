export type CollectionPeriodMode = 'CUSTOM' | 'TAX_YEAR'

export type TaxYearPeriodDraft = {
  mode: 'TAX_YEAR'
  taxYear: string
}

export type CustomPeriodDraft = {
  endDate: string
  mode: 'CUSTOM'
  startDate: string
}

export type CollectionPeriodDraft =
  | TaxYearPeriodDraft
  | CustomPeriodDraft

export type CollectionPeriodField = 'endDate' | 'startDate' | 'taxYear'

export type CollectionPeriodFieldErrorCode =
  | 'AFTER_LATEST_ALLOWED_DATE'
  | 'INVALID_FORMAT'
  | 'NOT_ALLOWED'
  | 'REQUIRED'
  | 'START_AFTER_END'

export type CollectionPeriodFieldErrors = Partial<
  Record<CollectionPeriodField, CollectionPeriodFieldErrorCode>
>

export type CollectionPeriodDateRange = {
  endDate: string
  startDate: string
}

export type CollectionPeriodLimits = {
  latestAllowedDate: string
  taxYears: string[]
}

export type CollectionPeriodSourceContext = {
  coverage: CollectionPeriodDateRange
  periodLimits: CollectionPeriodLimits
  sourceId: string
  sourceStatus: 'SOURCE_SAVED'
  sourceType: 'UPBIT_PDF'
  timezone: string
}

export type CollectionPeriodSourceContextError = {
  code:
    | 'SOURCE_CONTEXT_LOAD_FAILED'
    | 'SOURCE_CONTEXT_UNAVAILABLE'
  requestId?: string
}

export type LoadCollectionPeriodSourceResult =
  | {
      context: CollectionPeriodSourceContext
      ok: true
    }
  | {
      error: CollectionPeriodSourceContextError
      ok: false
    }

export type LoadCollectionPeriodSourceRequest = {
  signal: AbortSignal
  sourceId: string
}

export type LoadCollectionPeriodSource = (
  request: LoadCollectionPeriodSourceRequest,
) => Promise<LoadCollectionPeriodSourceResult>

export type InvalidDateRangeError = {
  code: 'INVALID_DATE_RANGE'
  fieldErrors: CollectionPeriodFieldErrors
  requestId?: string
}

export type SourceCoverageInsufficientError = {
  code: 'SOURCE_COVERAGE_INSUFFICIENT'
  missingRanges: CollectionPeriodDateRange[]
  requestId?: string
}

export type CollectionPeriodPreviewFailedError = {
  code: 'PREVIEW_FAILED'
  requestId?: string
}

export type CollectionPeriodError =
  | CollectionPeriodPreviewFailedError
  | InvalidDateRangeError
  | SourceCoverageInsufficientError

type NormalizedPeriodBase = CollectionPeriodDateRange & {
  timezone: string
}

export type NormalizedCollectionPeriod =
  | (NormalizedPeriodBase & {
      mode: 'TAX_YEAR'
      taxYear: string
    })
  | (NormalizedPeriodBase & {
      mode: 'CUSTOM'
    })

export type CollectionPeriodWarningCode =
  | 'ESTIMATED_TRANSACTION_COUNT_UNAVAILABLE'
  | 'REVIEW_RECOMMENDED'

export type CollectionPeriodWarning = {
  code: CollectionPeriodWarningCode
}

export type CollectionPeriodPreviewSuccess = {
  estimatedTransactionCount: number | null
  normalizedPeriod: NormalizedCollectionPeriod
  ok: true
  sourceCoverage: CollectionPeriodDateRange
  timezone: string
  warnings: CollectionPeriodWarning[]
}

export type CollectionPeriodPreviewFailure = {
  error: CollectionPeriodError
  ok: false
}

export type CollectionPeriodPreviewResult =
  | CollectionPeriodPreviewFailure
  | CollectionPeriodPreviewSuccess

export type CollectionPeriodPreviewRequest = {
  period: CollectionPeriodDraft
  signal: AbortSignal
  sourceId: string
}

export type PreviewCollectionPeriod = (
  request: CollectionPeriodPreviewRequest,
) => Promise<CollectionPeriodPreviewResult>

export type CollectionPeriodPreviewMockContext = {
  allowedTaxYears: string[]
  estimatedTransactionCount?: number | null
  latestAllowedDate: string
  sourceCoverage: CollectionPeriodDateRange
  timezone: string
  warnings?: CollectionPeriodWarning[]
}

type CollectionPeriodStateBase = {
  draft: CollectionPeriodDraft
  sourceId: string
}

export type CollectionPeriodState =
  | (CollectionPeriodStateBase & {
      error: null
      status: 'PERIOD_EDITING'
    })
  | (CollectionPeriodStateBase & {
      error: CollectionPeriodError
      status: 'PERIOD_INVALID'
    })
  | (CollectionPeriodStateBase & {
      status: 'PREVIEWING'
    })
  | (CollectionPeriodStateBase & {
      preview: CollectionPeriodPreviewSuccess
      status: 'READY_TO_COLLECT'
    })

export type CollectionPeriodAction =
  | {
      sourceId: string
      type: 'SOURCE_CHANGED'
    }
  | {
      type: 'SOURCE_CONTEXT_LOADING'
    }
  | {
      taxYears: string[]
      type: 'SOURCE_CONTEXT_RESOLVED'
    }
  | {
      draft: CollectionPeriodDraft
      type: 'DRAFT_CHANGED'
    }
  | {
      type: 'PREVIEW_STARTED'
    }
  | {
      error: CollectionPeriodError
      type: 'PREVIEW_FAILED'
    }
  | {
      preview: CollectionPeriodPreviewSuccess
      type: 'PREVIEW_SUCCEEDED'
    }
  | {
      type: 'PREVIEW_CANCELLED'
    }
  | {
      type: 'EDIT_REQUESTED'
    }

const DEFAULT_TAX_YEAR = '2027'
const MOCK_TIMEZONE = 'Asia/Seoul'
const MOCK_LATEST_ALLOWED_DATE = '2027-12-31'
const MOCK_TAX_YEARS = ['2027', '2026']

export const mockCollectionPeriodSourceCoverage: CollectionPeriodDateRange = {
  endDate: '2027-12-31',
  startDate: '2027-01-01',
}

const mockCollectionPeriodSourceIds = new Set([
  'src_upbit_preview',
  'src_upbit_preview_alt',
])

export function initialCollectionPeriodState(
  sourceId: string,
  draft: CollectionPeriodDraft = {
    mode: 'TAX_YEAR',
    taxYear: DEFAULT_TAX_YEAR,
  },
): CollectionPeriodState {
  return {
    draft,
    error: null,
    sourceId,
    status: 'PERIOD_EDITING',
  }
}

export function collectionPeriodReducer(
  state: CollectionPeriodState,
  action: CollectionPeriodAction,
): CollectionPeriodState {
  switch (action.type) {
    case 'SOURCE_CHANGED':
      return initialCollectionPeriodState(action.sourceId)
    case 'SOURCE_CONTEXT_LOADING':
      if (state.status === 'PERIOD_EDITING') {
        return state
      }

      return {
        draft: state.draft,
        error: null,
        sourceId: state.sourceId,
        status: 'PERIOD_EDITING',
      }
    case 'SOURCE_CONTEXT_RESOLVED': {
      const draft =
        state.draft.mode === 'TAX_YEAR' &&
        !action.taxYears.includes(state.draft.taxYear)
          ? {
              mode: 'TAX_YEAR' as const,
              taxYear: action.taxYears[0] ?? '',
            }
          : state.draft

      return {
        draft,
        error: null,
        sourceId: state.sourceId,
        status: 'PERIOD_EDITING',
      }
    }
    case 'DRAFT_CHANGED':
      if (state.status === 'PREVIEWING') {
        return state
      }

      return {
        draft: action.draft,
        error: null,
        sourceId: state.sourceId,
        status: 'PERIOD_EDITING',
      }
    case 'PREVIEW_STARTED': {
      if (
        state.status !== 'PERIOD_EDITING' &&
        state.status !== 'PERIOD_INVALID'
      ) {
        return state
      }

      const validationError = validateCollectionPeriodDraft(state.draft)
      if (validationError) {
        return {
          draft: state.draft,
          error: validationError,
          sourceId: state.sourceId,
          status: 'PERIOD_INVALID',
        }
      }

      return {
        draft: state.draft,
        sourceId: state.sourceId,
        status: 'PREVIEWING',
      }
    }
    case 'PREVIEW_FAILED':
      if (state.status !== 'PREVIEWING') {
        return state
      }

      return {
        draft: state.draft,
        error: action.error,
        sourceId: state.sourceId,
        status: 'PERIOD_INVALID',
      }
    case 'PREVIEW_SUCCEEDED':
      if (state.status !== 'PREVIEWING') {
        return state
      }

      return {
        draft: state.draft,
        preview: action.preview,
        sourceId: state.sourceId,
        status: 'READY_TO_COLLECT',
      }
    case 'PREVIEW_CANCELLED':
      if (state.status !== 'PREVIEWING') {
        return state
      }

      return {
        draft: state.draft,
        error: null,
        sourceId: state.sourceId,
        status: 'PERIOD_EDITING',
      }
    case 'EDIT_REQUESTED':
      if (
        state.status !== 'READY_TO_COLLECT' &&
        state.status !== 'PERIOD_INVALID'
      ) {
        return state
      }

      return {
        draft: state.draft,
        error: null,
        sourceId: state.sourceId,
        status: 'PERIOD_EDITING',
      }
  }
}

export function validateCollectionPeriodDraft(
  draft: CollectionPeriodDraft,
): InvalidDateRangeError | null {
  const fieldErrors: CollectionPeriodFieldErrors = {}

  if (draft.mode === 'TAX_YEAR') {
    if (draft.taxYear.length === 0) {
      fieldErrors.taxYear = 'REQUIRED'
    } else if (
      !/^[1-9]\d{3}$/.test(draft.taxYear) ||
      !isStrictIsoDate(`${draft.taxYear}-01-01`)
    ) {
      fieldErrors.taxYear = 'INVALID_FORMAT'
    }
  } else {
    if (draft.startDate.length === 0) {
      fieldErrors.startDate = 'REQUIRED'
    } else if (!isStrictIsoDate(draft.startDate)) {
      fieldErrors.startDate = 'INVALID_FORMAT'
    }

    if (draft.endDate.length === 0) {
      fieldErrors.endDate = 'REQUIRED'
    } else if (!isStrictIsoDate(draft.endDate)) {
      fieldErrors.endDate = 'INVALID_FORMAT'
    }

    if (
      !fieldErrors.startDate &&
      !fieldErrors.endDate &&
      draft.startDate > draft.endDate
    ) {
      fieldErrors.startDate = 'START_AFTER_END'
      fieldErrors.endDate = 'START_AFTER_END'
    }
  }

  if (Object.keys(fieldErrors).length === 0) {
    return null
  }

  return {
    code: 'INVALID_DATE_RANGE',
    fieldErrors,
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

function normalizeCollectionPeriod(
  period: CollectionPeriodDraft,
  timezone: string,
): NormalizedCollectionPeriod {
  if (period.mode === 'TAX_YEAR') {
    return {
      endDate: `${period.taxYear}-12-31`,
      mode: period.mode,
      startDate: `${period.taxYear}-01-01`,
      taxYear: period.taxYear,
      timezone,
    }
  }

  return {
    endDate: period.endDate,
    mode: period.mode,
    startDate: period.startDate,
    timezone,
  }
}

function findMissingCoverageRanges(
  period: CollectionPeriodDateRange,
  coverage: CollectionPeriodDateRange,
): CollectionPeriodDateRange[] {
  if (
    period.endDate < coverage.startDate ||
    period.startDate > coverage.endDate
  ) {
    return [{ ...period }]
  }

  const missingRanges: CollectionPeriodDateRange[] = []
  if (period.startDate < coverage.startDate) {
    missingRanges.push({
      endDate: shiftIsoDate(coverage.startDate, -1),
      startDate: period.startDate,
    })
  }
  if (period.endDate > coverage.endDate) {
    missingRanges.push({
      endDate: period.endDate,
      startDate: shiftIsoDate(coverage.endDate, 1),
    })
  }

  return missingRanges
}

function shiftIsoDate(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1))
  date.setUTCDate(date.getUTCDate() + days)

  return date.toISOString().slice(0, 10)
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException('The period preview was aborted.', 'AbortError')
  }
}

/**
 * UI-only authenticated-BFF boundary. Production must resolve the Source in
 * the active workspace and return the same safe error for missing and
 * cross-workspace resources.
 */
export const loadCollectionPeriodSourceMock: LoadCollectionPeriodSource =
  async ({ signal, sourceId }) => {
    throwIfAborted(signal)
    await Promise.resolve()
    throwIfAborted(signal)

    if (!mockCollectionPeriodSourceIds.has(sourceId)) {
      return {
        error: {
          code: 'SOURCE_CONTEXT_UNAVAILABLE',
          requestId: 'period-source-mock-unavailable',
        },
        ok: false,
      }
    }

    return {
      context: {
        coverage: { ...mockCollectionPeriodSourceCoverage },
        periodLimits: {
          latestAllowedDate: MOCK_LATEST_ALLOWED_DATE,
          taxYears: [...MOCK_TAX_YEARS],
        },
        sourceId,
        sourceStatus: 'SOURCE_SAVED',
        sourceType: 'UPBIT_PDF',
        timezone: MOCK_TIMEZONE,
      },
      ok: true,
    }
  }

export function createPreviewCollectionPeriodMock({
  allowedTaxYears,
  estimatedTransactionCount = 1_248,
  latestAllowedDate,
  sourceCoverage,
  timezone,
  warnings = [],
}: CollectionPeriodPreviewMockContext): PreviewCollectionPeriod {
  /**
   * UI-only preview boundary. It deliberately owns timezone normalization and
   * source-coverage checks so the client reducer never guesses server rules.
   */
  return async ({ period, signal, sourceId }) => {
    throwIfAborted(signal)
    await Promise.resolve()
    throwIfAborted(signal)

    const validationError = validateCollectionPeriodDraft(period)
    if (validationError) {
      return {
        error: validationError,
        ok: false,
      }
    }

    if (
      period.mode === 'TAX_YEAR' &&
      !allowedTaxYears.includes(period.taxYear)
    ) {
      return {
        error: {
          code: 'INVALID_DATE_RANGE',
          fieldErrors: {
            taxYear: 'NOT_ALLOWED',
          },
          requestId: 'period-preview-mock-tax-year',
        },
        ok: false,
      }
    }

    if (sourceId.length === 0) {
      return {
        error: {
          code: 'PREVIEW_FAILED',
          requestId: 'period-preview-mock-source',
        },
        ok: false,
      }
    }

    const normalizedPeriod = normalizeCollectionPeriod(period, timezone)
    const futureFieldErrors: CollectionPeriodFieldErrors = {}
    if (normalizedPeriod.endDate > latestAllowedDate) {
      if (period.mode === 'TAX_YEAR') {
        futureFieldErrors.taxYear = 'AFTER_LATEST_ALLOWED_DATE'
      } else {
        futureFieldErrors.endDate = 'AFTER_LATEST_ALLOWED_DATE'
        if (normalizedPeriod.startDate > latestAllowedDate) {
          futureFieldErrors.startDate = 'AFTER_LATEST_ALLOWED_DATE'
        }
      }
    }

    if (Object.keys(futureFieldErrors).length > 0) {
      return {
        error: {
          code: 'INVALID_DATE_RANGE',
          fieldErrors: futureFieldErrors,
          requestId: 'period-preview-mock-future',
        },
        ok: false,
      }
    }

    const missingRanges = findMissingCoverageRanges(
      normalizedPeriod,
      sourceCoverage,
    )
    if (missingRanges.length > 0) {
      return {
        error: {
          code: 'SOURCE_COVERAGE_INSUFFICIENT',
          missingRanges,
          requestId: 'period-preview-mock-coverage',
        },
        ok: false,
      }
    }

    return {
      estimatedTransactionCount,
      normalizedPeriod,
      ok: true,
      sourceCoverage: { ...sourceCoverage },
      timezone,
      warnings,
    }
  }
}

export const previewCollectionPeriodMock = createPreviewCollectionPeriodMock({
  allowedTaxYears: MOCK_TAX_YEARS,
  latestAllowedDate: MOCK_LATEST_ALLOWED_DATE,
  sourceCoverage: mockCollectionPeriodSourceCoverage,
  timezone: MOCK_TIMEZONE,
})
