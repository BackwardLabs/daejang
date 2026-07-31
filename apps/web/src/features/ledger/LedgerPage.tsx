import { Fragment, type FormEvent, useEffect, useRef, useState } from 'react'
import { AppSidebar } from '../../components/AppSidebar.tsx'
import { AppLink } from '../../components/AppLink.tsx'
import { ApiClientError } from '../../api/client.ts'
import {
  loadLedger,
  loadReview,
  loadReviews,
  resolveReview,
  type LedgerEventModel,
  type LedgerPostingModel,
  type ReviewDetailModel,
  type ReviewModel,
} from '../../api/productApi.ts'
import {
  loadAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import {
  describeLedgerAction,
  describeLedgerSource,
  describePostingDirection,
  describePostingRole,
  describeReviewReason,
  describeTransferEndpoint,
  formatCanonicalQuantity,
  formatLedgerMoney,
  formatLedgerQuantity,
  formatLedgerUnitPrice,
  parseLedgerAsset,
} from './ledgerPresentation.ts'
import './ledger.css'

const statusLabel = (value: string) => value === 'RESOLVED' ? '완료' : value === 'PARTIAL' ? '일부 확인' : '검토 필요'
const feeRoles = new Set(['FEE', 'GAS'])
const sourceKindLabels = { CEX: '거래소', WALLET: '개인지갑', UNKNOWN: '출처 미확인' } as const

const formatLedgerDateTime = (value: string) => new Date(value).toLocaleString('ko-KR', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
})

const describeReviewResolution = (review: ReviewDetailModel) =>
  review.options.find((option) => option.code === review.resolutionCode)?.label ??
  '선택한 처리 방식'

export const formatReviewQuantity = formatCanonicalQuantity

const preTaxEffectiveDate = new Date('2027-01-01T00:00:00+09:00')

function LedgerTaxCostBasis({
  posting,
  postings,
  effectiveAt,
}: {
  posting: LedgerPostingModel
  postings: LedgerPostingModel[]
  effectiveAt: string
}) {
  if (posting.costBasis) {
    return formatLedgerMoney(posting.costBasis, posting.denomination, postings)
  }
  const asset = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  if (posting.direction !== 'IN' || posting.role !== 'PRINCIPAL' || asset.symbol === 'KRW') return '—'
  const isPreTaxHolding = new Date(effectiveAt) < preTaxEffectiveDate
  return <span className="ledger-posting-value ledger-posting-tax-basis">
    <strong>산정 대기</strong>
    <small>{isPreTaxHolding ? '2026.12.31 기준 적용 예정' : 'Lot 계산 후 확정'}</small>
  </span>
}

function LedgerPostingRow({
  posting,
  postings,
  effectiveAt,
}: {
  posting: LedgerPostingModel
  postings: LedgerPostingModel[]
  effectiveAt: string
}) {
  const asset = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  const role = describePostingRole(posting.role)
  const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
  return <tr>
    <td>
      <span className="ledger-posting-value">
        <strong>{asset.symbol}</strong>
        {asset.metadata ? <small>{asset.metadata}</small> : null}
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-direction" data-direction={posting.direction}>
        <strong>{describePostingDirection(posting.direction)}</strong>
        <small>{posting.direction === 'IN' ? '자산 증가' : posting.direction === 'OUT' ? '자산 감소' : '확인 필요'}</small>
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-quantity">
        <strong>{quantity}{asset.decimals !== undefined ? ` ${asset.symbol}` : ''}</strong>
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-role">
        <strong>{role.label}</strong>
        <small>{role.description}</small>
      </span>
    </td>
    <td>{formatLedgerMoney(posting.fairValue, posting.denomination, postings)}</td>
    <td>{formatLedgerUnitPrice(posting, postings)}</td>
    <td><LedgerTaxCostBasis posting={posting} postings={postings} effectiveAt={effectiveAt} /></td>
  </tr>
}

function LedgerMovementList({ postings }: { postings: LedgerPostingModel[] }) {
  if (!postings.length) return <span className="ledger-explorer__empty-value">—</span>
  return <span className="ledger-explorer__movements">
    {postings.map((posting) => {
      const asset = parseLedgerAsset(
        posting.assetId,
        posting.assetSymbol,
        posting.hasAssetDecimals ? posting.assetDecimals : undefined,
        posting.assetVenue,
      )
      const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
      return <span key={posting.legId} className="ledger-explorer__movement" data-direction={posting.direction}>
        <b>{describePostingDirection(posting.direction)}</b>
        <strong>{quantity}{asset.decimals !== undefined ? ` ${asset.symbol}` : ''}</strong>
        {asset.decimals === undefined ? <small>{asset.symbol}</small> : null}
      </span>
    })}
  </span>
}

function LedgerStatusBadges({ event }: { event: LedgerEventModel }) {
  const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
  const valued = material.filter((posting) => posting.fairValue || posting.costBasis)
  return <span className="ledger-explorer__badges">
    <b className="is-primary" data-tone={event.resolution === 'RESOLVED' ? 'success' : 'warning'}>{statusLabel(event.resolution)}</b>
    {event.postings.length
      ? <b className="is-secondary" data-tone={event.resolution === 'RESOLVED' ? 'success' : 'warning'}>{event.resolution === 'RESOLVED' ? '장부 확정' : '장부 일부 반영'}</b>
      : <b className="is-secondary" data-tone="neutral">장부 미반영</b>}
    {valued.length === material.length && material.length > 0
      ? <b className="is-secondary" data-tone="success">평가 완료</b>
      : valued.length > 0
        ? <b className="is-secondary" data-tone="warning">일부 평가</b>
        : <b className="is-secondary" data-tone="neutral">평가 대기</b>}
  </span>
}

function LedgerExplorerDetail({
  event,
  reviewNavigationStatus,
  onOpenReview,
}: {
  event: LedgerEventModel
  reviewNavigationStatus: 'idle' | 'loading' | 'error'
  onOpenReview: (eventId: string) => void
}) {
  const source = describeLedgerSource(event.postings)
  const action = describeLedgerAction(event.eventType, event.flowShape, event.postings, event.subtype)
  const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
  const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
  const valued = material.filter((posting) => posting.fairValue || posting.costBasis)
  const transferEndpoint = event.eventType === 'TRANSFER'
    && !['FIAT_IN', 'FIAT_OUT'].includes(event.flowShape)
    && !['FIAT_DEPOSIT', 'FIAT_WITHDRAWAL'].includes(event.subtype ?? '')
    ? describeTransferEndpoint(event.postings, event.transferEndpoint)
    : undefined
  return <div className="ledger-explorer-detail">
    <div className="ledger-explorer-detail__summary">
      <section><span>입력 출처</span><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]}</small></section>
      <section><span>확인된 액션</span><strong>{action.label}</strong><small>{action.description}</small></section>
      <section><span>장부 반영</span><strong>{material.length}건</strong><small>자산 변동 · 수수료 {fees.length}건</small></section>
      <section><span>세무 처리</span><strong>{valued.length ? `${valued.length}건 평가` : '평가 대기'}</strong><small>취득 원가와 세금 결과로 연결</small></section>
    </div>

    {transferEndpoint ? <section className="ledger-explorer-endpoint" data-tone={transferEndpoint.tone}>
      <span>{transferEndpoint.label}</span>
      <div><strong>{transferEndpoint.title}</strong><small>{transferEndpoint.detail}</small></div>
      {event.transferEndpoint?.reviewRequired ? <span className="ledger-explorer-endpoint__actions">
        <b>{transferEndpoint.status}</b>
        <button
          type="button"
          className="ledger-explorer-endpoint__review"
          disabled={reviewNavigationStatus === 'loading'}
          onClick={() => onOpenReview(event.eventId)}
        >
          {reviewNavigationStatus === 'loading' ? '검토 찾는 중…' : '검토하러 가기'}
        </button>
      </span> : <b>{transferEndpoint.status}</b>}
      {reviewNavigationStatus === 'error' ? <p role="alert">이 거래의 열린 검토를 찾지 못했습니다. 검토 목록을 새로고침한 뒤 다시 시도해 주세요.</p> : null}
    </section> : null}

    <section className="ledger-explorer-detail__postings" aria-labelledby={`posting-title-${event.eventId}`}>
      <header>
        <div><span>확정 장부</span><h3 id={`posting-title-${event.eventId}`}>자산 변동과 세무 입력</h3></div>
        <b>{event.postings.length}건</b>
      </header>
      {event.postings.length ? <div className="ledger-posting-table"><table><thead><tr><th>자산</th><th>방향</th><th>수량</th><th>역할</th><th>당시 취득·처분 금액</th><th>평균 단가</th><th>세무 취득원가</th></tr></thead><tbody>{event.postings.map((posting) => <LedgerPostingRow key={posting.legId} posting={posting} postings={event.postings} effectiveAt={event.effectiveAt} />)}</tbody></table></div> : <p>현재 변경본에 확정된 장부 반영 내역이 없습니다.</p>}
    </section>

    <details className="ledger-explorer-provenance">
      <summary>검증용 원본 정보</summary>
      <dl>
        <div><dt>출처 식별자</dt><dd>{source.detail}</dd></div>
        <div><dt>거래 식별자</dt><dd>{event.eventId}</dd></div>
        <div><dt>자산 식별자</dt><dd>{[...new Set(event.postings.map((posting) => posting.assetId))].join(' · ') || '없음'}</dd></div>
        <div><dt>현재 변경본</dt><dd>{event.revisionNumber}번 · {event.revisionId}</dd></div>
        <div><dt>해석 상태</dt><dd>{event.interpretationSupport}</dd></div>
        <div><dt>흐름 코드</dt><dd>{event.flowShape}</dd></div>
        <div>
          <dt>원본 수량</dt>
          <dd>
            {event.postings
              .map((posting) => `${posting.legId}: ${posting.quantity}`)
              .join(' · ') || '없음'}
          </dd>
        </div>
      </dl>
    </details>
  </div>
}

export function LedgerPage() {
  const [year, setYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [events, setEvents] = useState<LedgerEventModel[]>([])
  const ledgerGenerationRef = useRef(0)
  const [reviews, setReviews] = useState<ReviewModel[]>([])
  const [reviewCursor, setReviewCursor] = useState<string>()
  const [reviewPageStatus, setReviewPageStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [reviewStatus, setReviewStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reviewReloadKey, setReviewReloadKey] = useState(0)
  const reviewListGenerationRef = useRef(0)
  const [reviewOccurredAtById, setReviewOccurredAtById] = useState<Record<string, string>>({})
  const [reviewNavigation, setReviewNavigation] = useState<{ eventId?: string; status: 'idle' | 'loading' | 'error' }>({ status: 'idle' })
  const [selectedId, setSelectedId] = useState<string>()
  const [selectedReviewId, setSelectedReviewId] = useState<string>()
  const selectedReviewIdRef = useRef<string | undefined>(undefined)
  const reviewDetailGenerationRef = useRef(0)
  const [reviewDetail, setReviewDetail] = useState<ReviewDetailModel>()
  const [reviewDetailStatus, setReviewDetailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [resolutionCode, setResolutionCode] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [resolutionStatus, setResolutionStatus] = useState<'idle' | 'submitting' | 'refreshing' | 'success' | 'error' | 'stale' | 'stale-error' | 'conflict' | 'reanalyze'>('idle')
  const [resolutionIntentKey, setResolutionIntentKey] = useState<string>()
  const [view, setView] = useState<'ledger' | 'review'>('ledger')
  const [ledgerStatus, setLedgerStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [ledgerReloadKey, setLedgerReloadKey] = useState(0)

  function handleYearChange(nextYear: AppYear) {
    setYear(nextYear)
    saveAppYear(nextYear)
  }

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++ledgerGenerationRef.current
    setLedgerStatus('loading')
    setEvents([])
    setSelectedId(undefined)
    void loadLedger(year, controller.signal)
      .then((ledger) => {
        if (ledgerGenerationRef.current !== generation) return
        setEvents(ledger.items)
        setLedgerStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          ledgerGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setLedgerStatus('error')
      })
    return () => controller.abort()
  }, [ledgerReloadKey, year])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++reviewListGenerationRef.current
    setReviewStatus('loading')
    setReviewPageStatus('idle')
    setReviewNavigation({ status: 'idle' })
    setReviews([])
    setReviewCursor(undefined)
    selectedReviewIdRef.current = undefined
    setSelectedReviewId(undefined)
    void loadReviews({ signal: controller.signal })
      .then((review) => {
        if (reviewListGenerationRef.current !== generation) return
        setReviews(review.items)
        setReviewCursor(review.nextCursor)
        const firstReviewId = review.items[0]?.id
        selectedReviewIdRef.current = firstReviewId
        setSelectedReviewId(firstReviewId)
        setReviewStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          reviewListGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setReviewStatus('error')
      })
    return () => controller.abort()
  }, [reviewReloadKey])

  useEffect(() => {
    selectedReviewIdRef.current = selectedReviewId
    const generation = ++reviewDetailGenerationRef.current
    if (!selectedReviewId) {
      setReviewDetail(undefined)
      setReviewDetailStatus('idle')
      return
    }
    const controller = new AbortController()
    setReviewDetailStatus('loading')
    setResolutionStatus('idle')
    setResolutionIntentKey(undefined)
    void loadReview(selectedReviewId, controller.signal)
      .then(({ review }) => {
        if (
          selectedReviewIdRef.current !== selectedReviewId ||
          reviewDetailGenerationRef.current !== generation
        ) return
        setReviewDetail(review)
        const occurredAt = review.observations
          .map((observation) => observation.occurredAt)
          .filter((value): value is string => Boolean(value))
          .sort()[0]
        if (occurredAt) {
          setReviewOccurredAtById((current) => current[review.id] === occurredAt
            ? current
            : { ...current, [review.id]: occurredAt })
        }
        setResolutionCode(review.options[0]?.code ?? '')
        setResolutionNote('')
        setReviewDetailStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          selectedReviewIdRef.current === selectedReviewId &&
          reviewDetailGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setReviewDetailStatus('error')
      })
    return () => controller.abort()
  }, [selectedReviewId])

  const selectedOption = reviewDetail?.options.find((option) => option.code === resolutionCode)
  const resolutionBusy = resolutionStatus === 'submitting' || resolutionStatus === 'refreshing'
  const resolutionBlocked = resolutionStatus === 'reanalyze'
  const ledgerCount = ledgerStatus === 'ready' ? `${events.length}건` : '—'
  const reviewCount = reviewStatus === 'ready' ? `${reviews.length}건` : '—'

  const selectReview = (reviewId: string) => {
    selectedReviewIdRef.current = reviewId
    setSelectedReviewId(reviewId)
  }

  const changeResolutionCode = (code: string) => {
    setResolutionCode(code)
    setResolutionIntentKey(undefined)
    setResolutionStatus('idle')
  }

  const changeResolutionNote = (note: string) => {
    setResolutionNote(note)
    setResolutionIntentKey(undefined)
    setResolutionStatus('idle')
  }

  const loadMoreReviews = async () => {
    if (!reviewCursor || reviewPageStatus === 'loading') return
    const generation = reviewListGenerationRef.current
    setReviewPageStatus('loading')
    try {
      const page = await loadReviews({ cursor: reviewCursor })
      if (reviewListGenerationRef.current !== generation) return
      setReviews((current) => {
        const seen = new Set(current.map((review) => review.id))
        return [...current, ...page.items.filter((review) => !seen.has(review.id))]
      })
      setReviewCursor(page.nextCursor)
      setReviewPageStatus('idle')
    } catch {
      if (reviewListGenerationRef.current === generation) setReviewPageStatus('error')
    }
  }

  const openReviewForEvent = async (eventId: string) => {
    if (reviewNavigation.status === 'loading') return
    const loadedReview = reviews.find((review) => review.executionId === eventId && review.status === 'OPEN')
    if (loadedReview) {
      selectReview(loadedReview.id)
      setReviewNavigation({ status: 'idle' })
      setView('review')
      return
    }

    const generation = reviewListGenerationRef.current
    let cursor = reviewCursor
    const loadedIds = new Set(reviews.map((review) => review.id))
    setReviewNavigation({ eventId, status: 'loading' })
    try {
      while (cursor) {
        const page = await loadReviews({ cursor })
        if (reviewListGenerationRef.current !== generation) return
        const newItems = page.items.filter((review) => !loadedIds.has(review.id))
        newItems.forEach((review) => loadedIds.add(review.id))
        setReviews((current) => [...current, ...newItems])
        setReviewCursor(page.nextCursor)
        const matchingReview = page.items.find((review) => review.executionId === eventId && review.status === 'OPEN')
        if (matchingReview) {
          selectReview(matchingReview.id)
          setReviewNavigation({ status: 'idle' })
          setView('review')
          return
        }
        cursor = page.nextCursor
      }
      setReviewNavigation({ eventId, status: 'error' })
    } catch {
      if (reviewListGenerationRef.current === generation) {
        setReviewNavigation({ eventId, status: 'error' })
      }
    }
  }

  const submitResolution = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!reviewDetail || !resolutionCode || resolutionBusy || resolutionBlocked) return
    const submittedReviewId = reviewDetail.id
    const submittedGeneration = reviewDetailGenerationRef.current
    const intentKey = resolutionIntentKey ?? crypto.randomUUID()
    setResolutionIntentKey(intentKey)
    setResolutionStatus('submitting')
    try {
      const result = await resolveReview(submittedReviewId, {
        expectedRevisionId: reviewDetail.revisionId,
        expectedPointerVersion: String(reviewDetail.pointerVersion),
        resolutionCode,
        resolutionNote,
        intentKey,
      })
      setReviews((current) => current.map((review) => review.id === result.review.id ? {
        ...review,
        revisionId: result.review.revisionId,
        pointerVersion: result.review.pointerVersion,
        status: result.review.status,
      } : review))
      if (
        selectedReviewIdRef.current !== submittedReviewId ||
        reviewDetailGenerationRef.current !== submittedGeneration
      ) return
      setReviewDetail(result.review)
      setResolutionStatus('success')
      setResolutionIntentKey(undefined)
    } catch (error) {
      if (
        selectedReviewIdRef.current !== submittedReviewId ||
        reviewDetailGenerationRef.current !== submittedGeneration
      ) return
      if (error instanceof ApiClientError && error.code === 'REVIEW_STALE') {
        setResolutionStatus('refreshing')
        setResolutionIntentKey(undefined)
        try {
          const latest = await loadReview(submittedReviewId)
          if (
            selectedReviewIdRef.current !== submittedReviewId ||
            reviewDetailGenerationRef.current !== submittedGeneration
          ) return
          setReviewDetail(latest.review)
          setResolutionCode(latest.review.options[0]?.code ?? '')
          setResolutionNote('')
          setResolutionStatus('stale')
        } catch {
          if (
            selectedReviewIdRef.current === submittedReviewId &&
            reviewDetailGenerationRef.current === submittedGeneration
          ) {
            setResolutionStatus('stale-error')
          }
        }
        return
      }
      if (error instanceof ApiClientError && error.code === 'REVIEW_INTENT_CONFLICT') {
        setResolutionIntentKey(undefined)
        setResolutionStatus('conflict')
        return
      }
      if (error instanceof ApiClientError && error.code === 'REVIEW_LINEAGE_UNAVAILABLE') {
        setResolutionIntentKey(undefined)
        setResolutionStatus('reanalyze')
        return
      }
      setResolutionStatus('error')
    }
  }

  return (
    <div className="ledger-page product-shell">
      <AppSidebar
        activePage="ledger"
        year={year}
        onYearChange={handleYearChange}
      />
      <main className="ledger-main">
        <section className="ledger-header" aria-labelledby="ledger-page-title">
          <div className="ledger-header__copy">
            <p>장부 작업</p>
            <h1 id="ledger-page-title">거래 장부</h1>
            <span>수집된 거래와 검토가 필요한 항목을 한곳에서 확인합니다.</span>
          </div>
          <div className="ledger-header__actions">
            <button
              type="button"
              aria-label={`전체 거래 ${ledgerCount}`}
              aria-pressed={view === 'ledger'}
              className={view === 'ledger' ? 'is-active' : undefined}
              onClick={() => setView('ledger')}
            >
              <span>전체 거래</span>
              <strong>{ledgerCount}</strong>
            </button>
            <button
              type="button"
              aria-label={`검토 필요 ${reviewCount}`}
              aria-pressed={view === 'review'}
              className={view === 'review' ? 'is-active' : undefined}
              onClick={() => setView('review')}
            >
              <span>검토 필요</span>
              <strong>{reviewCount}</strong>
            </button>
          </div>
        </section>

        {view === 'ledger' && ledgerStatus === 'error' ? (
          <section className="ledger-state-card ledger-state-card--error" role="alert">
            <h2>장부를 불러오지 못했습니다</h2>
            <p>잠시 후 다시 시도해 주세요. 계속 문제가 생기면 운영팀에 문의해 주세요</p>
            <button type="button" onClick={() => setLedgerReloadKey((current) => current + 1)}>장부 다시 불러오기</button>
          </section>
        ) : null}
        {view === 'ledger' && ledgerStatus === 'loading' ? (
          <section className="ledger-state-card ledger-state-card--loading" role="status">
            <p>장부를 불러오는 중입니다</p>
          </section>
        ) : null}

        {ledgerStatus === 'ready' && view === 'ledger' ? (
          events.length === 0 ? (
            <section className="ledger-state-card ledger-state-card--empty">
              <h2>아직 처리된 거래가 없습니다</h2>
              <p>데이터 소스를 등록하고 거래 수집이 완료되면 실제 거래가 여기에 표시됩니다</p>
              <AppLink href="/sources">데이터 소스 관리</AppLink>
            </section>
          ) : (
            <section className="ledger-explorer" aria-label="거래 장부">
              <header className="ledger-explorer__heading">
                <div><h2>거래</h2><span>{events.length}건 · 장부 반영 {events.reduce((count, event) => count + event.postings.length, 0)}건</span></div>
                <small>원본 근거부터 세무 처리까지 거래별로 확인합니다.</small>
              </header>
              <div className="ledger-explorer__table-wrap">
                <table className="ledger-explorer__table">
                  <thead><tr><th>시간</th><th>출처 / 거래</th><th>확인된 액션</th><th>내 자산 변화</th><th>수수료</th><th>상태</th></tr></thead>
                  <tbody>{events.map((event) => {
                    const source = describeLedgerSource(event.postings)
                    const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
                    const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
                    const action = describeLedgerAction(event.eventType, event.flowShape, event.postings, event.subtype)
                    const isOpen = event.eventId === selectedId
                    return <Fragment key={event.eventId}>
                      <tr className={isOpen ? 'ledger-explorer__row is-open' : 'ledger-explorer__row'}>
                        <td className="ledger-explorer__time">
                          <span className="ledger-explorer__time-content">
                            <button type="button" aria-label={`${action.label} 거래 상세 ${isOpen ? '접기' : '보기'}`} aria-expanded={isOpen} aria-controls={`ledger-detail-${event.eventId}`} onClick={() => setSelectedId(isOpen ? undefined : event.eventId)}>{isOpen ? '접기' : '보기'}</button>
                            <time dateTime={event.effectiveAt}>{formatLedgerDateTime(event.effectiveAt)}</time>
                          </span>
                        </td>
                        <td><span className="ledger-explorer__source"><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]}</small></span></td>
                        <td><span className="ledger-explorer__action" data-action={action.label}><strong>{action.label}</strong><small>{action.description}</small></span></td>
                        <td><LedgerMovementList postings={material} /></td>
                        <td><LedgerMovementList postings={fees} /></td>
                        <td><LedgerStatusBadges event={event} /></td>
                      </tr>
                      {isOpen ? <tr className="ledger-explorer__detail-row"><td colSpan={6}><div id={`ledger-detail-${event.eventId}`}><LedgerExplorerDetail
                        event={event}
                        reviewNavigationStatus={reviewNavigation.eventId === event.eventId ? reviewNavigation.status : 'idle'}
                        onOpenReview={openReviewForEvent}
                      /></div></td></tr> : null}
                    </Fragment>
                  })}</tbody>
                </table>
              </div>
            </section>
          )
        ) : null}

        {view === 'review' ? (
          <p className="ledger-review-scope">
            검토 목록은 조회 연도와 관계없이 전체 기간의 열린 항목을 보여줍니다
          </p>
        ) : null}
        {view === 'review' && reviewStatus === 'loading' ? (
          <section className="ledger-state-card ledger-state-card--loading" role="status">
            <p>검토 목록을 불러오는 중입니다</p>
          </section>
        ) : null}
        {view === 'review' && reviewStatus === 'error' ? (
          <section className="ledger-state-card ledger-state-card--error" role="alert">
            <h2>검토 목록을 불러오지 못했습니다</h2>
            <p>장부는 계속 확인할 수 있습니다</p>
            <button type="button" onClick={() => setReviewReloadKey((current) => current + 1)}>검토 다시 불러오기</button>
          </section>
        ) : null}

        {reviewStatus === 'ready' && view === 'review' ? (
          reviews.length === 0 ? <section className="ledger-state-card ledger-state-card--empty"><h2>열린 검토가 없습니다</h2><p>추가 확인이 필요한 거래가 생기면 사유와 근거가 여기에 표시됩니다</p></section> :
          <section className="ledger-review-browser" aria-label="열린 검토">
            <div className="ledger-review-browser__list">
              {reviews.map((review) => {
                const occurredAt = events.find((event) => event.eventId === review.executionId)?.effectiveAt
                  ?? reviewOccurredAtById[review.id]
                return <button type="button" key={review.id} className={review.id === selectedReviewId ? 'is-selected' : undefined} onClick={() => selectReview(review.id)}>
                <span><strong>{describeReviewReason(review.reasonCodes[0] ?? '')}</strong><small>{occurredAt ? formatLedgerDateTime(occurredAt) : '거래 시각은 상세에서 확인'}</small></span>
                <b>{statusLabel(review.status)}</b>
              </button>})}
              {reviewCursor ? <button type="button" className="ledger-review-browser__more" onClick={loadMoreReviews} disabled={reviewPageStatus === 'loading'}>
                {reviewPageStatus === 'loading' ? '검토 불러오는 중…' : '검토 더 보기'}
              </button> : null}
              {reviewPageStatus === 'error' ? <p role="alert">다음 검토 목록을 불러오지 못했습니다. 다시 시도해 주세요.</p> : null}
            </div>
            <div className="ledger-review-browser__detail">
              {reviewDetailStatus === 'loading' ? <p role="status">검토 상세를 불러오는 중입니다.</p> : null}
              {reviewDetailStatus === 'error' ? <p role="alert">검토 상세를 불러오지 못했습니다.</p> : null}
              {reviewDetailStatus === 'ready' && reviewDetail ? <article>
                <header><div><span>거래 검토</span><h2>{describeReviewReason(reviewDetail.reasonCodes[0] ?? '')}</h2></div><b>{statusLabel(reviewDetail.status)}</b></header>
                <p>{reviewDetail.reasonCodes.map(describeReviewReason).join(' · ') || '추가 확인이 필요한 거래입니다'}</p>
                <details className="ledger-explorer-provenance">
                  <summary>검증용 원본 정보</summary>
                  <dl>
                    <div><dt>검토 식별자</dt><dd>{reviewDetail.id}</dd></div>
                    <div><dt>현재 변경본</dt><dd>{reviewDetail.revisionNumber}번 · {reviewDetail.revisionId}</dd></div>
                    <div><dt>연결 버전</dt><dd>{String(reviewDetail.pointerVersion)}</dd></div>
                    <div><dt>원본 사유 코드</dt><dd>{reviewDetail.reasonCodes.join(' · ') || '없음'}</dd></div>
                  </dl>
                </details>
                <section className="ledger-review-evidence" aria-labelledby="review-evidence-heading">
                  <header>
                    <div><span>검토 근거</span><h3 id="review-evidence-heading">응답할 거래 근거</h3></div>
                    <b>{reviewDetail.observations.length}건</b>
                  </header>
                  <p>자산과 수량을 먼저 확인하고, 필요하면 원본 정보를 펼쳐 보세요.</p>
                  <ul>
                    {reviewDetail.observations.map((observation) => {
                      const quantity = formatReviewQuantity(
                        observation.quantity,
                        observation.hasAssetDecimals ? observation.assetDecimals : undefined,
                      )
                      return <li key={`${observation.fragmentId}:${observation.observationId}`}>
                        <div className="ledger-review-evidence__summary">
                          <strong>{observation.assetSymbol || '거래 근거'}</strong>
                          <b>{quantity}{observation.assetSymbol ? ` ${observation.assetSymbol}` : ''}</b>
                        </div>
                        <details className="ledger-explorer-provenance">
                          <summary>거래 원본 정보 확인</summary>
                          <dl>
                            <div><dt>거래·원본 식별자</dt><dd>{observation.nativeId || observation.originLinkId || observation.observationId}</dd></div>
                            <div><dt>발생 시각</dt><dd>{observation.occurredAt ? new Date(observation.occurredAt).toLocaleString('ko-KR') : '제공되지 않음'}</dd></div>
                            <div><dt>계정·지갑</dt><dd>{[observation.accountLabel, observation.accountLocator, observation.accountChainId].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
                            <div><dt>자산 식별자</dt><dd>{[observation.assetSymbol, observation.assetLocator].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
                            <div><dt>근거 유형</dt><dd>{[observation.domain, observation.kind].filter(Boolean).join(' · ') || observation.originKind || '제공되지 않음'}</dd></div>
                          </dl>
                        </details>
                      </li>
                    })}
                  </ul>
                </section>
                {reviewDetail.status === 'OPEN' ? <form className="ledger-review-form" onSubmit={submitResolution}>
                  <fieldset disabled={resolutionBusy || resolutionBlocked}>
                    <legend>이 거래를 어떻게 처리할까요?</legend>
                    {reviewDetail.options.map((option) => <label key={option.code}>
                      <input type="radio" name="resolutionCode" value={option.code} checked={resolutionCode === option.code} onChange={() => changeResolutionCode(option.code)} />
                      <span><strong>{option.label}</strong><small>{option.requiresEvidence ? '근거 설명 필수' : '추가 설명 선택'}</small></span>
                    </label>)}
                  </fieldset>
                  <label className="ledger-review-form__note">
                    <span>검토 메모{selectedOption?.requiresEvidence ? ' (필수)' : ' (선택)'}</span>
                    <textarea value={resolutionNote} onChange={(event) => changeResolutionNote(event.target.value)} maxLength={4000} required={selectedOption?.requiresEvidence} disabled={resolutionBusy || resolutionBlocked} placeholder="판단 근거나 거래 맥락을 남겨 주세요." />
                  </label>
                  <button type="submit" disabled={!resolutionCode || resolutionBusy || resolutionBlocked || Boolean(selectedOption?.requiresEvidence && !resolutionNote.trim())}>
                    {resolutionStatus === 'submitting' ? '응답 저장 중…' : resolutionStatus === 'refreshing' ? '최신 응답 불러오는 중…' : resolutionStatus === 'reanalyze' ? '운영 확인 필요' : '이 응답으로 검토 완료'}
                  </button>
                  {resolutionStatus === 'submitting' ? <p role="status">검토 응답을 안전하게 저장하는 중입니다.</p> : null}
                  {resolutionStatus === 'refreshing' ? <p role="status">다른 변경이 먼저 반영되어 최신 내용을 불러오는 중입니다.</p> : null}
                  {resolutionStatus === 'success' ? <p className="is-success" role="status">검토가 완료되었습니다.</p> : null}
                  {resolutionStatus === 'stale' ? <p role="alert">다른 변경이 먼저 반영되어 최신 내용을 다시 불러왔습니다. 응답을 확인해 다시 제출해 주세요.</p> : null}
                  {resolutionStatus === 'stale-error' ? <p role="alert">변경된 최신 내용을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.</p> : null}
                  {resolutionStatus === 'conflict' ? <p role="alert">같은 요청을 처리하는 중 내용이 달라졌습니다. 최신 내용을 확인한 뒤 다시 제출해 주세요.</p> : null}
                  {resolutionStatus === 'reanalyze' ? <p role="alert">이 검토에는 필요한 분석 정보가 없어 응답을 저장하지 않았습니다. 운영팀이 데이터 준비 상태를 확인해야 합니다.</p> : null}
                  {resolutionStatus === 'error' ? <p role="alert">응답을 저장하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.</p> : null}
                </form> : <p className="ledger-review-resolved" role="status">{resolutionStatus === 'success'
                  ? `검토가 완료되었습니다. (${describeReviewResolution(reviewDetail)})`
                  : `이 검토는 '${describeReviewResolution(reviewDetail)}' 처리로 완료되었습니다.`}</p>}
              </article> : null}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  )
}
