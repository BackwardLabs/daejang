import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type RefObject,
} from 'react'
import pdfStepActive from '../../assets/sources/pdf-step-active.svg'
import pdfStepComplete from '../../assets/sources/pdf-step-complete.svg'
import pdfStepInactive from '../../assets/sources/pdf-step-inactive.svg'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'
import {
  collectionPeriodReducer,
  createPreviewCollectionPeriodMock,
  initialCollectionPeriodState,
  loadCollectionPeriodSourceMock,
  validateCollectionPeriodDraft,
  type CollectionPeriodDateRange,
  type CollectionPeriodDraft,
  type CollectionPeriodError,
  type CollectionPeriodFieldErrorCode,
  type CollectionPeriodFieldErrors,
  type CollectionPeriodLimits,
  type CollectionPeriodPreviewSuccess,
  type CollectionPeriodSourceContext,
  type CollectionPeriodSourceContextError,
  type LoadCollectionPeriodSource,
  type PreviewCollectionPeriod,
} from './collectionPeriod.ts'
import './collection-period.css'

const collectionPeriodSteps = [
  '소스 등록',
  '조회 기간 설정',
  '수집 전 확인',
] as const

const fieldErrorCopy: Record<CollectionPeriodFieldErrorCode, string> = {
  AFTER_LATEST_ALLOWED_DATE: '미래 날짜는 선택할 수 없습니다.',
  INVALID_FORMAT: 'YYYY-MM-DD 형식의 실제 날짜를 입력해 주세요.',
  NOT_ALLOWED: '현재 데이터 소스에서 선택할 수 없는 과세연도입니다.',
  REQUIRED: '필수 입력값입니다.',
  START_AFTER_END: '시작일은 종료일보다 늦을 수 없습니다.',
}

export type CollectionPeriodSourceContextInput = {
  coverage: CollectionPeriodDateRange
  periodLimits?: CollectionPeriodLimits
  timezone: string
}

const warningCopy = {
  ESTIMATED_TRANSACTION_COUNT_UNAVAILABLE:
    '예상 거래 건수를 아직 계산할 수 없습니다. 실제 수집 전에 기간과 데이터 소스를 한 번 더 확인해 주세요.',
  REVIEW_RECOMMENDED:
    '수집 시작 전에 선택한 기간과 데이터 소스 정보를 한 번 더 확인해 주세요.',
} satisfies Record<
  CollectionPeriodPreviewSuccess['warnings'][number]['code'],
  string
>

type CollectionPeriodSourceLoadState =
  | {
      status: 'LOADING'
    }
  | {
      context: CollectionPeriodSourceContext
      status: 'READY'
    }
  | {
      error: CollectionPeriodSourceContextError
      status: 'ERROR'
    }

function resolveSourceContextInput(
  sourceId: string,
  sourceContext: CollectionPeriodSourceContextInput,
): CollectionPeriodSourceContext {
  const coverageEndYear = sourceContext.coverage.endDate.slice(0, 4)
  const previousYear = String(Number(coverageEndYear) - 1)

  return {
    coverage: { ...sourceContext.coverage },
    periodLimits: sourceContext.periodLimits
      ? {
          latestAllowedDate:
            sourceContext.periodLimits.latestAllowedDate,
          taxYears: [...sourceContext.periodLimits.taxYears],
        }
      : {
          latestAllowedDate: sourceContext.coverage.endDate,
          taxYears: [coverageEndYear, previousYear],
        },
    sourceId,
    sourceStatus: 'SOURCE_SAVED',
    sourceType: 'UPBIT_PDF',
    timezone: sourceContext.timezone,
  }
}

function formatDate(date: string) {
  return date.replaceAll('-', '.')
}

function formatRange(range: CollectionPeriodDateRange) {
  return `${formatDate(range.startDate)} – ${formatDate(range.endDate)}`
}

function getDraftRange(draft: CollectionPeriodDraft) {
  if (draft.mode === 'TAX_YEAR') {
    return {
      endDate: `${draft.taxYear}-12-31`,
      startDate: `${draft.taxYear}-01-01`,
    }
  }

  return {
    endDate: draft.endDate,
    startDate: draft.startDate,
  }
}

function CollectionPeriodStepper({
  currentStep,
}: {
  currentStep: number
}) {
  return (
    <nav
      className="collection-period-stepper"
      aria-label="데이터 수집 준비 단계"
    >
      <ol>
        {collectionPeriodSteps.map((label, index) => {
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
                ? pdfStepActive
                : pdfStepInactive

          return (
            <li
              key={label}
              className={`collection-period-stepper__item collection-period-stepper__item--${state}`}
              aria-current={state === 'active' ? 'step' : undefined}
            >
              <span className="collection-period-stepper__marker">
                <img src={icon} alt="" />
                <span aria-hidden="true">
                  {state === 'complete' ? '✓' : step}
                </span>
              </span>
              <strong>{label}</strong>
              <span className="collection-period-stepper__state">
                {state === 'complete'
                  ? '완료'
                  : state === 'active'
                    ? '진행 중'
                    : '대기'}
              </span>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function CollectionPeriodErrorNotice({
  error,
  noticeRef,
}: {
  error: CollectionPeriodError
  noticeRef: RefObject<HTMLDivElement | null>
}) {
  const copy =
    error.code === 'INVALID_DATE_RANGE'
      ? {
          body: '표시된 입력값을 확인한 뒤 다시 요청해 주세요.',
          title: '조회 기간을 확인해 주세요',
        }
      : error.code === 'SOURCE_COVERAGE_INSUFFICIENT'
        ? {
            body: '등록한 PDF에 포함되지 않은 기간이 있습니다. 기간을 줄이거나 다른 거래내역서를 등록해 주세요.',
            title: 'PDF가 선택 기간 전체를 포함하지 않아요',
          }
        : {
            body: '입력한 기간은 유지됩니다. 잠시 후 같은 범위로 다시 확인해 주세요.',
            title: '조회 범위를 확인하지 못했어요',
          }

  return (
    <div
      ref={noticeRef}
      id="collection-period-error"
      className="collection-period-alert"
      role="alert"
      tabIndex={-1}
    >
      <span className="collection-period-alert__icon" aria-hidden="true">
        !
      </span>
      <div>
        <strong>{copy.title}</strong>
        <p>{copy.body}</p>
        {error.code === 'SOURCE_COVERAGE_INSUFFICIENT' ? (
          <ul aria-label="PDF에 포함되지 않은 기간">
            {error.missingRanges.map((range) => (
              <li key={`${range.startDate}-${range.endDate}`}>
                {formatRange(range)}
              </li>
            ))}
          </ul>
        ) : null}
        {error.requestId ? (
          <span className="collection-period-alert__request">
            요청 ID: {error.requestId}
          </span>
        ) : null}
        {error.code === 'SOURCE_COVERAGE_INSUFFICIENT' ? (
          <div className="collection-period-alert__actions">
            <a
              className="pdf-secondary-action"
              href="/sources/new/upbit/upload"
            >
              다른 PDF 등록
            </a>
            <span>다른 PDF를 등록해도 현재 데이터 소스는 삭제되지 않습니다.</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PeriodFieldError({
  code,
  id,
}: {
  code: CollectionPeriodFieldErrorCode | undefined
  id: string
}) {
  return code ? (
    <p id={id} className="collection-period-field__error">
      {fieldErrorCopy[code]}
    </p>
  ) : null
}

function SourceSummary({
  sourceId,
}: {
  sourceId: string
}) {
  return (
    <div className="collection-source-summary">
      <span className="collection-source-summary__logo">
        <img src={upbitLogo} alt="" />
      </span>
      <span className="collection-source-summary__identity">
        <strong>Upbit 거래내역서</strong>
        <span>{sourceId}</span>
      </span>
      <span className="collection-source-summary__status">저장 완료</span>
    </div>
  )
}

function CollectionPeriodAside({
  sourceContext,
}: {
  sourceContext: CollectionPeriodSourceContext
}) {
  return (
    <aside className="collection-period-aside" aria-label="조회 기간 확인 기준">
      <section className="collection-period-aside__card">
        <span className="collection-period-aside__eyebrow">
          문서 포함 범위
        </span>
        <h2>PDF 포함 기간</h2>
        <div className="collection-period-aside__range">
          <span>서버가 확인한 문서 범위</span>
          <strong>{formatRange(sourceContext.coverage)}</strong>
        </div>
        <ul className="collection-period-aside__list">
          <li>
            <span aria-hidden="true">01</span>
            <p>선택 기간이 문서 범위 안에 있는지 서버가 최종 확인합니다.</p>
          </li>
          <li>
            <span aria-hidden="true">02</span>
            <p>문서보다 좁은 기간을 선택해도 원본 PDF는 변경하지 않습니다.</p>
          </li>
          <li>
            <span aria-hidden="true">03</span>
            <p>누락 구간이 있으면 수집 시작 전에 기간을 수정합니다.</p>
          </li>
        </ul>
      </section>

      <section className="collection-period-aside__card collection-period-aside__card--subtle">
        <span className="collection-period-aside__eyebrow">기준 시간대</span>
        <h2>{sourceContext.timezone}</h2>
        <p>
          날짜는 서비스 기준 시간대로 정규화합니다. 시간대 변경은 설정에서
          진행합니다.
        </p>
      </section>
    </aside>
  )
}

function CollectionPeriodEditor({
  draft,
  error,
  isPreviewing,
  noticeRef,
  onCancel,
  onChange,
  onPreview,
  sourceContext,
  sourceId,
}: {
  draft: CollectionPeriodDraft
  error: CollectionPeriodError | null
  isPreviewing: boolean
  noticeRef: RefObject<HTMLDivElement | null>
  onCancel: () => void
  onChange: (draft: CollectionPeriodDraft) => void
  onPreview: () => void
  sourceContext: CollectionPeriodSourceContext
  sourceId: string
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const taxYearRef = useRef<HTMLSelectElement>(null)
  const startDateRef = useRef<HTMLInputElement>(null)
  const endDateRef = useRef<HTMLInputElement>(null)
  const fieldErrors: CollectionPeriodFieldErrors =
    error?.code === 'INVALID_DATE_RANGE' ? error.fieldErrors : {}
  const range = getDraftRange(draft)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!error) {
      return
    }

    if (error.code === 'INVALID_DATE_RANGE') {
      if (error.fieldErrors.taxYear) {
        taxYearRef.current?.focus()
        return
      }

      if (error.fieldErrors.startDate) {
        startDateRef.current?.focus()
        return
      }

      if (error.fieldErrors.endDate) {
        endDateRef.current?.focus()
        return
      }
    }

    noticeRef.current?.focus()
  }, [error, noticeRef])

  function changeMode(mode: CollectionPeriodDraft['mode']) {
    if (mode === draft.mode) {
      return
    }

    if (mode === 'TAX_YEAR') {
      const candidateTaxYear =
        draft.mode === 'CUSTOM' && /^\d{4}/.test(draft.startDate)
          ? draft.startDate.slice(0, 4)
          : ''
      const taxYear =
        sourceContext.periodLimits.taxYears.includes(candidateTaxYear)
          ? candidateTaxYear
          : (sourceContext.periodLimits.taxYears[0] ?? '')

      onChange({
        mode,
        taxYear,
      })
      return
    }

    const currentRange = getDraftRange(draft)
    onChange({
      endDate: currentRange.endDate,
      mode,
      startDate: currentRange.startDate,
    })
  }

  return (
    <section
      className="collection-period-card"
      aria-labelledby="collection-period-editor-title"
    >
      <div className="collection-period-card__heading">
        <span>PERIOD EDITING</span>
        <h2
          ref={headingRef}
          id="collection-period-editor-title"
          tabIndex={-1}
        >
          조회 기간과 문서 범위를 확인하세요
        </h2>
        <p>
          PDF에서 확인된 기간 안에서 과세연도 전체 또는 직접 기간을
          선택합니다.
        </p>
      </div>

      {error ? (
        <CollectionPeriodErrorNotice error={error} noticeRef={noticeRef} />
      ) : null}

      <SourceSummary sourceId={sourceId} />

      <dl className="collection-source-facts">
        <div>
          <dt>문서 포함 기간</dt>
          <dd>{formatRange(sourceContext.coverage)}</dd>
        </div>
        <div>
          <dt>기준 시간대</dt>
          <dd>{sourceContext.timezone}</dd>
        </div>
      </dl>

      <div className="collection-range-panel">
        <div className="collection-range-panel__heading">
          <h3>조회 기간</h3>
          <p>양 끝 날짜를 모두 포함합니다.</p>
        </div>

        <div
          className="collection-range-modes"
          role="radiogroup"
          aria-label="조회 기간 방식"
        >
          <label className="collection-range-mode">
            <input
              type="radio"
              name="collection-period-mode"
              value="TAX_YEAR"
              checked={draft.mode === 'TAX_YEAR'}
              disabled={isPreviewing}
              onChange={() => changeMode('TAX_YEAR')}
            />
            과세연도 전체
          </label>
          <label className="collection-range-mode">
            <input
              type="radio"
              name="collection-period-mode"
              value="CUSTOM"
              checked={draft.mode === 'CUSTOM'}
              disabled={isPreviewing}
              onChange={() => changeMode('CUSTOM')}
            />
            직접 기간 설정
          </label>
        </div>

        <div className="collection-period-fields">
          {draft.mode === 'TAX_YEAR' ? (
            <div className="collection-period-field collection-period-field--full">
              <label htmlFor="collection-tax-year">과세연도</label>
              <select
                ref={taxYearRef}
                id="collection-tax-year"
                value={draft.taxYear}
                disabled={isPreviewing}
                aria-invalid={fieldErrors.taxYear ? 'true' : undefined}
                aria-describedby={
                  fieldErrors.taxYear
                    ? 'collection-tax-year-error'
                    : undefined
                }
                onChange={(event) =>
                  onChange({
                    mode: 'TAX_YEAR',
                    taxYear: event.currentTarget.value,
                  })
                }
              >
                {sourceContext.periodLimits.taxYears.map((taxYear) => (
                  <option key={taxYear} value={taxYear}>
                    {taxYear}년
                  </option>
                ))}
              </select>
              <PeriodFieldError
                code={fieldErrors.taxYear}
                id="collection-tax-year-error"
              />
            </div>
          ) : null}

          <div className="collection-period-field">
            <label htmlFor="collection-period-start">시작일</label>
            <input
              ref={startDateRef}
              id="collection-period-start"
              type="date"
              value={range.startDate}
              max={sourceContext.periodLimits.latestAllowedDate}
              readOnly={draft.mode === 'TAX_YEAR'}
              disabled={isPreviewing}
              aria-invalid={fieldErrors.startDate ? 'true' : undefined}
              aria-describedby={
                fieldErrors.startDate
                  ? 'collection-period-start-error'
                  : 'collection-period-format'
              }
              onChange={(event) => {
                if (draft.mode === 'CUSTOM') {
                  onChange({
                    ...draft,
                    startDate: event.currentTarget.value,
                  })
                }
              }}
            />
            <PeriodFieldError
              code={fieldErrors.startDate}
              id="collection-period-start-error"
            />
          </div>

          <div className="collection-period-field">
            <label htmlFor="collection-period-end">종료일</label>
            <input
              ref={endDateRef}
              id="collection-period-end"
              type="date"
              value={range.endDate}
              max={sourceContext.periodLimits.latestAllowedDate}
              readOnly={draft.mode === 'TAX_YEAR'}
              disabled={isPreviewing}
              aria-invalid={fieldErrors.endDate ? 'true' : undefined}
              aria-describedby={
                fieldErrors.endDate
                  ? 'collection-period-end-error'
                  : 'collection-period-format'
              }
              onChange={(event) => {
                if (draft.mode === 'CUSTOM') {
                  onChange({
                    ...draft,
                    endDate: event.currentTarget.value,
                  })
                }
              }}
            />
            <PeriodFieldError
              code={fieldErrors.endDate}
              id="collection-period-end-error"
            />
          </div>
        </div>

        <p
          id="collection-period-format"
          className="collection-range-panel__footer"
        >
          <span>
            입력 형식 <strong>YYYY-MM-DD</strong>
          </span>
          <span>선택 가능 범위와 문서 포함 기간은 서버에서 최종 확인</span>
        </p>
      </div>

      {isPreviewing ? (
        <div
          className="collection-period-preview-status"
          role="status"
          aria-live="polite"
        >
          <span
            className="collection-period-preview-status__spinner"
            aria-hidden="true"
          />
          <div>
            <strong>조회 범위와 예상 거래 건수를 확인하고 있어요</strong>
            <p>등록한 데이터 소스는 유지되며 아직 수집은 시작되지 않습니다.</p>
          </div>
        </div>
      ) : null}

      <div
        className={`collection-period-actions${
          isPreviewing ? '' : ' collection-period-actions--end'
        }`}
      >
        {isPreviewing ? (
          <button
            type="button"
            className="pdf-secondary-action"
            onClick={onCancel}
          >
            확인 취소
          </button>
        ) : null}
        <button
          type="button"
          className="source-primary-action"
          disabled={isPreviewing}
          onClick={onPreview}
        >
          {isPreviewing ? '확인 중…' : '조회 범위 확인'}
          {!isPreviewing ? <span aria-hidden="true">→</span> : null}
        </button>
      </div>
    </section>
  )
}

function CollectionPeriodReady({
  onEdit,
  preview,
  sourceId,
}: {
  onEdit: () => void
  preview: CollectionPeriodPreviewSuccess
  sourceId: string
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  return (
    <section
      className="collection-period-ready-card"
      aria-labelledby="collection-period-ready-title"
    >
      <span className="collection-period-ready-card__eyebrow">
        READY TO COLLECT
      </span>
      <h2 ref={headingRef} id="collection-period-ready-title" tabIndex={-1}>
        조회 기간 확인이 끝났어요
      </h2>
      <p>
        서버가 정규화한 기간과 PDF 포함 범위를 확인했습니다. 아직 수집은
        시작되지 않았습니다.
      </p>

      <dl className="collection-period-ready-summary">
        <div>
          <dt>데이터 소스</dt>
          <dd>Upbit · {sourceId}</dd>
        </div>
        <div>
          <dt>PDF 포함 기간</dt>
          <dd>{formatRange(preview.sourceCoverage)}</dd>
        </div>
        <div>
          <dt>선택한 조회 기간</dt>
          <dd>{formatRange(preview.normalizedPeriod)}</dd>
        </div>
        <div>
          <dt>기준 시간대</dt>
          <dd>{preview.timezone}</dd>
        </div>
        <div>
          <dt>예상 거래 건수</dt>
          <dd>
            {preview.estimatedTransactionCount === null
              ? '계산 중'
              : `약 ${preview.estimatedTransactionCount.toLocaleString('ko-KR')}건`}
          </dd>
        </div>
      </dl>

      {preview.warnings.length > 0 ? (
        <div className="collection-period-ready-note">
          <strong>수집 전에 확인할 내용</strong>
          <ul>
            {preview.warnings.map((warning) => (
              <li key={warning.code}>{warningCopy[warning.code]}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="collection-period-ready-note">
          <strong>Coverage 확인 완료</strong>
          선택한 기간 전체가 등록한 PDF 범위 안에 있습니다. 예상 건수는 실제
          수집 결과와 다를 수 있습니다.
        </div>
      )}

      <div className="collection-period-actions">
        <button
          type="button"
          className="pdf-secondary-action"
          onClick={onEdit}
        >
          기간 수정
        </button>
        <button
          type="button"
          className="source-primary-action"
          disabled
          aria-describedby="collection-job-follow-up"
        >
          수집 시작 <span aria-hidden="true">→</span>
        </button>
      </div>
      <p id="collection-job-follow-up" className="collection-period-follow-up">
        수집 시작 기능은 다음 개발 단계에서 연결됩니다.
      </p>
    </section>
  )
}

function CollectionPeriodSourceLoading() {
  return (
    <section
      className="collection-period-source-state"
      aria-labelledby="collection-period-source-loading-title"
      role="status"
      aria-live="polite"
    >
      <span
        className="collection-period-source-state__spinner"
        aria-hidden="true"
      />
      <div>
        <span className="collection-period-source-state__eyebrow">
          데이터 소스 확인
        </span>
        <h2 id="collection-period-source-loading-title">
          등록한 데이터 소스를 확인 중입니다
        </h2>
        <p>
          현재 계정에서 사용할 수 있는 데이터 소스인지 확인한 뒤 조회 기간을
          표시합니다.
        </p>
      </div>
    </section>
  )
}

function CollectionPeriodSourceError({
  error,
  onRetry,
}: {
  error: CollectionPeriodSourceContextError
  onRetry: () => void
}) {
  const isTransient = error.code === 'SOURCE_CONTEXT_LOAD_FAILED'

  return (
    <section
      className="collection-period-source-state collection-period-source-state--error"
      aria-labelledby="collection-period-source-error-title"
      role="alert"
    >
      <span
        className="collection-period-source-state__error-icon"
        aria-hidden="true"
      >
        !
      </span>
      <div>
        <span className="collection-period-source-state__eyebrow">
          데이터 소스 오류
        </span>
        <h2 id="collection-period-source-error-title">
          {isTransient
            ? '데이터 소스를 불러오지 못했어요'
            : '데이터 소스를 확인할 수 없어요'}
        </h2>
        <p>
          {isTransient
            ? '일시적인 문제로 데이터 소스 정보를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.'
            : '요청한 데이터 소스가 없거나 현재 계정에서 사용할 수 없습니다. 새 데이터 소스를 등록한 뒤 다시 진행해 주세요.'}
        </p>
        {error.requestId ? (
          <span className="collection-period-source-state__request">
            요청 ID: {error.requestId}
          </span>
        ) : null}
        {isTransient ? (
          <button
            type="button"
            className="source-primary-action"
            onClick={onRetry}
          >
            다시 확인 <span aria-hidden="true">↻</span>
          </button>
        ) : (
          <a className="source-primary-action" href="/sources/new">
            새 데이터 소스 등록 <span aria-hidden="true">→</span>
          </a>
        )}
      </div>
    </section>
  )
}

export function CollectionPeriodPage({
  loadSourceContext = loadCollectionPeriodSourceMock,
  previewPeriod,
  sourceContext: sourceContextInput,
  sourceId,
}: {
  loadSourceContext?: LoadCollectionPeriodSource
  previewPeriod?: PreviewCollectionPeriod
  sourceContext?: CollectionPeriodSourceContextInput
  sourceId: string
}) {
  const [state, dispatch] = useReducer(
    collectionPeriodReducer,
    sourceId,
    initialCollectionPeriodState,
  )
  const [sourceLoadState, setSourceLoadState] =
    useState<CollectionPeriodSourceLoadState>(() =>
      sourceContextInput
        ? {
            context: resolveSourceContextInput(sourceId, sourceContextInput),
            status: 'READY',
          }
        : { status: 'LOADING' },
    )
  const [sourceLoadAttempt, setSourceLoadAttempt] = useState(0)
  const activeRequestRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)
  const noticeRef = useRef<HTMLDivElement>(null)
  const previewingRef = useRef(false)
  const sourceLoadRequestRef = useRef(0)
  const sourceContextTaxYearsKey =
    sourceContextInput?.periodLimits?.taxYears.join('|')
  const resolvedSourceContext =
    sourceLoadState.status === 'READY' &&
    sourceLoadState.context.sourceId === sourceId &&
    state.sourceId === sourceId
      ? sourceLoadState.context
      : null
  const previewAdapter = useMemo(
    () => {
      if (previewPeriod) {
        return previewPeriod
      }

      if (!resolvedSourceContext) {
        return null
      }

      return createPreviewCollectionPeriodMock({
        allowedTaxYears:
          resolvedSourceContext.periodLimits.taxYears,
        latestAllowedDate:
          resolvedSourceContext.periodLimits.latestAllowedDate,
        sourceCoverage: resolvedSourceContext.coverage,
        timezone: resolvedSourceContext.timezone,
      })
    },
    [
      previewPeriod,
      resolvedSourceContext?.coverage.endDate,
      resolvedSourceContext?.coverage.startDate,
      resolvedSourceContext?.periodLimits.latestAllowedDate,
      resolvedSourceContext?.periodLimits.taxYears,
      resolvedSourceContext?.timezone,
    ],
  )
  const isReady =
    resolvedSourceContext !== null &&
    state.status === 'READY_TO_COLLECT' &&
    state.sourceId === sourceId
  const isPreviewing = state.status === 'PREVIEWING'
  const error = state.status === 'PERIOD_INVALID' ? state.error : null
  const currentStep = isReady ? 3 : 2

  useEffect(() => {
    if (state.sourceId === sourceId) {
      return
    }

    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    previewingRef.current = false
    dispatch({ sourceId, type: 'SOURCE_CHANGED' })
  }, [sourceId, state.sourceId])

  useEffect(() => {
    const requestId = sourceLoadRequestRef.current + 1
    sourceLoadRequestRef.current = requestId
    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    previewingRef.current = false
    dispatch({ type: 'SOURCE_CONTEXT_LOADING' })

    if (sourceContextInput) {
      const context = resolveSourceContextInput(
        sourceId,
        sourceContextInput,
      )
      setSourceLoadState({
        context,
        status: 'READY',
      })
      dispatch({
        taxYears: context.periodLimits.taxYears,
        type: 'SOURCE_CONTEXT_RESOLVED',
      })
      return
    }

    const controller = new AbortController()
    setSourceLoadState({ status: 'LOADING' })

    void loadSourceContext({
      signal: controller.signal,
      sourceId,
    })
      .then((result) => {
        if (
          sourceLoadRequestRef.current !== requestId ||
          controller.signal.aborted
        ) {
          return
        }

        if (result.ok && result.context.sourceId === sourceId) {
          setSourceLoadState({
            context: result.context,
            status: 'READY',
          })
          dispatch({
            taxYears: result.context.periodLimits.taxYears,
            type: 'SOURCE_CONTEXT_RESOLVED',
          })
          return
        }

        setSourceLoadState({
          error: result.ok
            ? { code: 'SOURCE_CONTEXT_UNAVAILABLE' }
            : result.error,
          status: 'ERROR',
        })
      })
      .catch(() => {
        if (
          sourceLoadRequestRef.current === requestId &&
          !controller.signal.aborted
        ) {
          setSourceLoadState({
            error: { code: 'SOURCE_CONTEXT_LOAD_FAILED' },
            status: 'ERROR',
          })
        }
      })

    return () => {
      controller.abort()
    }
  }, [
    loadSourceContext,
    sourceContextInput?.periodLimits?.latestAllowedDate,
    sourceContextInput?.coverage.endDate,
    sourceContextInput?.coverage.startDate,
    sourceContextInput?.timezone,
    sourceContextTaxYearsKey,
    sourceLoadAttempt,
    sourceId,
  ])

  useEffect(
    () => () => {
      activeRequestRef.current += 1
      abortControllerRef.current?.abort()
      sourceLoadRequestRef.current += 1
    },
    [],
  )

  async function handlePreview() {
    if (
      isPreviewing ||
      previewingRef.current ||
      !previewAdapter ||
      !resolvedSourceContext ||
      state.sourceId !== sourceId
    ) {
      return
    }

    const validationError = validateCollectionPeriodDraft(state.draft)
    dispatch({ type: 'PREVIEW_STARTED' })
    if (validationError) {
      return
    }

    previewingRef.current = true
    const requestId = activeRequestRef.current + 1
    activeRequestRef.current = requestId
    const controller = new AbortController()
    abortControllerRef.current = controller

    try {
      const result = await previewAdapter({
        period: state.draft,
        signal: controller.signal,
        sourceId: state.sourceId,
      })

      if (
        activeRequestRef.current !== requestId ||
        controller.signal.aborted
      ) {
        return
      }

      if (result.ok) {
        dispatch({ preview: result, type: 'PREVIEW_SUCCEEDED' })
      } else {
        dispatch({ error: result.error, type: 'PREVIEW_FAILED' })
      }
    } catch {
      if (
        activeRequestRef.current === requestId &&
        !controller.signal.aborted
      ) {
        dispatch({
          error: { code: 'PREVIEW_FAILED' },
          type: 'PREVIEW_FAILED',
        })
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        abortControllerRef.current = null
        previewingRef.current = false
      }
    }
  }

  function handleCancelPreview() {
    if (!isPreviewing) {
      return
    }

    activeRequestRef.current += 1
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    previewingRef.current = false
    dispatch({ type: 'PREVIEW_CANCELLED' })
  }

  const pageCopy = isReady
    ? {
        description:
          '정규화된 조회 기간과 문서 포함 범위를 수집 전에 확인합니다.',
        title: '수집 전 확인',
      }
    : {
        description:
          '등록한 Upbit PDF의 포함 기간 안에서 조회 범위를 설정합니다.',
        title: '조회 기간 설정',
      }

  return (
    <SourceFlowLayout
      badge={{
        label: resolvedSourceContext
          ? `${currentStep} / 3`
          : '데이터 소스 확인',
        tone: 'upbit',
      }}
      description={pageCopy.description}
      eyebrow="DATA SOURCES · UPBIT"
      title={pageCopy.title}
    >
      {resolvedSourceContext ? (
        <CollectionPeriodStepper currentStep={currentStep} />
      ) : null}

      {!resolvedSourceContext ? (
        sourceLoadState.status === 'ERROR' ? (
          <CollectionPeriodSourceError
            error={sourceLoadState.error}
            onRetry={() =>
              setSourceLoadAttempt((attempt) => attempt + 1)
            }
          />
        ) : (
          <CollectionPeriodSourceLoading />
        )
      ) : (
        <>
          <div className="collection-period-grid">
            {isReady && state.status === 'READY_TO_COLLECT' ? (
              <CollectionPeriodReady
                onEdit={() => dispatch({ type: 'EDIT_REQUESTED' })}
                preview={state.preview}
                sourceId={state.sourceId}
              />
            ) : (
              <CollectionPeriodEditor
                draft={state.draft}
                error={error}
                isPreviewing={isPreviewing}
                noticeRef={noticeRef}
                onCancel={handleCancelPreview}
                onChange={(draft) =>
                  dispatch({ draft, type: 'DRAFT_CHANGED' })
                }
                onPreview={handlePreview}
                sourceContext={resolvedSourceContext}
                sourceId={state.sourceId}
              />
            )}

            <CollectionPeriodAside sourceContext={resolvedSourceContext} />
          </div>

          <p className="source-footer-note">
            선택한 정확한 날짜와 예상 거래 건수는 URL·브라우저 저장소·분석
            이벤트에 남기지 않습니다.
          </p>
        </>
      )}
    </SourceFlowLayout>
  )
}
