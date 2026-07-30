import { Fragment, type FormEvent, useEffect, useRef, useState } from 'react'
import { AppSidebar, defaultAppYear, type AppYear } from '../../components/AppSidebar.tsx'
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
  describeFlowShape,
  describeLedgerSource,
  describePostingDirection,
  describePostingRole,
  formatCanonicalQuantity,
  formatLedgerQuantity,
  parseLedgerAsset,
} from './ledgerPresentation.ts'
import './ledger.css'

const eventLabels: Record<string, string> = {
  TRADE: '거래', TRANSFER: '전송', SWAP: '스왑', BRIDGE: '브리지', REWARD: '보상',
  BORROW: '대여', REPAY: '상환', STAKE: '스테이킹', LIQUIDITY: '유동성', WRAP: '래핑',
  UNKNOWN: '미분류', OTHER: '기타',
}
const statusLabel = (value: string) => value === 'RESOLVED' ? '완료' : value === 'PARTIAL' ? '일부 확인' : '검토 필요'
const feeRoles = new Set(['FEE', 'GAS'])
const sourceKindLabels = { CEX: '거래소', WALLET: '개인지갑', UNKNOWN: '출처 미확인' } as const

const compactIdentifier = (value: string) => value.length > 30
  ? `${value.slice(0, 16)}…${value.slice(-10)}`
  : value

const formatLedgerDateTime = (value: string) => new Date(value).toLocaleString('ko-KR', {
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
})

const formatMoney = (amount: string, denomination: string) =>
  amount ? `${amount}${denomination ? ` ${denomination}` : ''}` : '—'

export const formatReviewQuantity = formatCanonicalQuantity

function LedgerPostingRow({ posting }: { posting: LedgerPostingModel }) {
  const asset = parseLedgerAsset(posting.assetId)
  const role = describePostingRole(posting.role)
  const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
  return <tr>
    <td>
      <span className="ledger-posting-value" title={posting.assetId}>
        <strong>{asset.symbol}</strong>
        {asset.metadata ? <small>{asset.metadata}</small> : null}
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-direction" data-direction={posting.direction}>
        <strong>{describePostingDirection(posting.direction)}</strong>
        <small>{posting.direction}</small>
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-quantity">
        <strong>{quantity}{asset.decimals !== undefined ? ` ${asset.symbol}` : ''}</strong>
        {asset.decimals !== undefined ? <small>원시값 {posting.quantity}</small> : null}
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-role">
        <strong>{role.label}</strong>
        <small>{role.description}</small>
      </span>
    </td>
    <td>{formatMoney(posting.fairValue, posting.denomination)}</td>
    <td>{formatMoney(posting.costBasis, posting.denomination)}</td>
  </tr>
}

function LedgerMovementList({ postings }: { postings: LedgerPostingModel[] }) {
  if (!postings.length) return <span className="ledger-explorer__empty-value">—</span>
  return <span className="ledger-explorer__movements">
    {postings.map((posting) => {
      const asset = parseLedgerAsset(posting.assetId)
      const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
      return <span key={posting.legId} className="ledger-explorer__movement" data-direction={posting.direction}>
        <b>{posting.direction}</b>
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
    <b data-tone={event.resolution === 'RESOLVED' ? 'success' : 'warning'}>{statusLabel(event.resolution)}</b>
    {event.postings.length
      ? <b data-tone={event.resolution === 'RESOLVED' ? 'success' : 'warning'}>{event.resolution === 'RESOLVED' ? '장부 확정' : '장부 일부 반영'}</b>
      : <b data-tone="neutral">장부 미반영</b>}
    {valued.length === material.length && material.length > 0
      ? <b data-tone="success">평가 완료</b>
      : valued.length > 0
        ? <b data-tone="warning">일부 평가</b>
        : <b data-tone="neutral">평가 대기</b>}
  </span>
}

function LedgerExplorerDetail({ event }: { event: LedgerEventModel }) {
  const source = describeLedgerSource(event.postings)
  const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
  const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
  const valued = material.filter((posting) => posting.fairValue || posting.costBasis)
  return <div className="ledger-explorer-detail">
    <div className="ledger-explorer-detail__summary">
      <section><span>입력 출처</span><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]} · {compactIdentifier(source.detail)}</small></section>
      <section><span>확인된 액션</span><strong>{eventLabels[event.eventType] ?? event.eventType}</strong><small>{describeFlowShape(event.flowShape)}</small></section>
      <section><span>장부 반영</span><strong>{material.length}건</strong><small>자산 변동 · 수수료 {fees.length}건</small></section>
      <section><span>세무 처리</span><strong>{valued.length ? `${valued.length}건 평가` : '평가 대기'}</strong><small>원가·Lot·세금 결과로 연결</small></section>
    </div>

    <ol className="ledger-explorer-lineage" aria-label="거래 처리 계보">
      <li className="is-complete"><i>1</i><span><strong>Evidence</strong><small>{source.label} 관찰 근거</small></span></li>
      <li className={event.resolution === 'RESOLVED' ? 'is-complete' : 'is-pending'}><i>2</i><span><strong>{source.kind === 'WALLET' ? 'ActionProof' : source.kind === 'CEX' ? '결정적 CEX 해석' : '해석 입력'}</strong><small>{source.kind === 'WALLET' ? 'JIT가 봉인한 실행·effect 증명' : `${describeFlowShape(event.flowShape)} 입력`}</small></span></li>
      <li className={event.postings.length ? 'is-complete' : 'is-pending'}><i>3</i><span><strong>Event · Posting</strong><small>{event.postings.length ? `${eventLabels[event.eventType] ?? event.eventType} · ${event.postings.length}개 장부 행` : '분류·장부 확정 대기'}</small></span></li>
      <li className={valued.length ? 'is-complete' : 'is-pending'}><i>4</i><span><strong>KRW Valuation</strong><small>{valued.length ? `${valued.length}건 평가 연결` : 'Tax Engine 처리 대기'}</small></span></li>
      <li className="is-pending"><i>5</i><span><strong>Lot · Tax Report</strong><small>세금 리포트에서 최종 결과 확인</small></span></li>
    </ol>

    <section className="ledger-explorer-detail__postings" aria-labelledby={`posting-title-${event.eventId}`}>
      <header>
        <div><span>CANONICAL LEDGER</span><h3 id={`posting-title-${event.eventId}`}>자산 변동과 세무 입력</h3></div>
        <b>{event.postings.length} rows</b>
      </header>
      {event.postings.length ? <div className="ledger-posting-table"><table><thead><tr><th>자산</th><th>방향</th><th>수량</th><th>역할</th><th>평가액</th><th>취득원가</th></tr></thead><tbody>{event.postings.map((posting) => <LedgerPostingRow key={posting.legId} posting={posting} />)}</tbody></table></div> : <p>이 revision에 확정된 Posting이 없습니다.</p>}
    </section>

    <details className="ledger-explorer-provenance">
      <summary>검증 정보 · Event와 revision</summary>
      <dl>
        <div><dt>Event ID</dt><dd>{event.eventId}</dd></div>
        <div><dt>현재 revision</dt><dd>rev.{event.revisionNumber} · {event.revisionId}</dd></div>
        <div><dt>해석 상태</dt><dd>{event.interpretationSupport}</dd></div>
        <div><dt>흐름 코드</dt><dd>{event.flowShape}</dd></div>
      </dl>
    </details>
  </div>
}

export function LedgerPage() {
  const [year, setYear] = useState<AppYear>(defaultAppYear)
  const [events, setEvents] = useState<LedgerEventModel[]>([])
  const ledgerGenerationRef = useRef(0)
  const [reviews, setReviews] = useState<ReviewModel[]>([])
  const [reviewCursor, setReviewCursor] = useState<string>()
  const [reviewPageStatus, setReviewPageStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [reviewStatus, setReviewStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reviewReloadKey, setReviewReloadKey] = useState(0)
  const reviewListGenerationRef = useRef(0)
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
        setSelectedId(ledger.items[0]?.eventId)
        setLedgerStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          ledgerGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setLedgerStatus('error')
      })
    return () => controller.abort()
  }, [year])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++reviewListGenerationRef.current
    setReviewStatus('loading')
    setReviewPageStatus('idle')
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
  }, [reviewReloadKey, year])

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
      <AppSidebar activePage="ledger" year={year} onYearChange={setYear} />
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
            <p>Engine과 데이터베이스 연결을 확인한 뒤 다시 시도해 주세요</p>
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
              <p>데이터 소스를 등록하고 Sync Job이 완료되면 실제 거래가 여기에 표시됩니다</p>
              <AppLink href="/sources">데이터 소스 관리</AppLink>
            </section>
          ) : (
            <section className="ledger-explorer" aria-label="거래 장부">
              <header className="ledger-explorer__heading">
                <div><h2>거래</h2><span>{events.length}건 · Posting {events.reduce((count, event) => count + event.postings.length, 0)}개</span></div>
                <small>Evidence부터 세무 처리까지 한 거래 단위로 확인합니다.</small>
              </header>
              <div className="ledger-explorer__table-wrap">
                <table className="ledger-explorer__table">
                  <thead><tr><th>시간</th><th>출처 / 거래</th><th>확인된 액션</th><th>내 자산 변화</th><th>수수료</th><th>상태</th></tr></thead>
                  <tbody>{events.map((event) => {
                    const source = describeLedgerSource(event.postings)
                    const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
                    const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
                    const isOpen = event.eventId === selectedId
                    return <Fragment key={event.eventId}>
                      <tr className={isOpen ? 'ledger-explorer__row is-open' : 'ledger-explorer__row'}>
                        <td className="ledger-explorer__time">
                          <button type="button" aria-expanded={isOpen} aria-controls={`ledger-detail-${event.eventId}`} onClick={() => setSelectedId(isOpen ? undefined : event.eventId)}>{isOpen ? '닫기' : '상세'}</button>
                          <time dateTime={event.effectiveAt}>{formatLedgerDateTime(event.effectiveAt)}</time>
                        </td>
                        <td><span className="ledger-explorer__source"><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]} · {compactIdentifier(source.detail)}</small></span></td>
                        <td><span className="ledger-explorer__action"><strong>{eventLabels[event.eventType] ?? event.eventType}</strong><small>{describeFlowShape(event.flowShape)}</small></span></td>
                        <td><LedgerMovementList postings={material} /></td>
                        <td><LedgerMovementList postings={fees} /></td>
                        <td><LedgerStatusBadges event={event} /></td>
                      </tr>
                      {isOpen ? <tr className="ledger-explorer__detail-row"><td colSpan={6}><div id={`ledger-detail-${event.eventId}`}><LedgerExplorerDetail event={event} /></div></td></tr> : null}
                    </Fragment>
                  })}</tbody>
                </table>
              </div>
            </section>
          )
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
          reviews.length === 0 ? <section className="ledger-state-card ledger-state-card--empty"><h2>열린 검토가 없습니다</h2><p>Engine이 판단 보류 항목을 만들면 사유와 근거가 여기에 표시됩니다</p></section> :
          <section className="ledger-review-browser" aria-label="열린 검토">
            <div className="ledger-review-browser__list">
              {reviews.map((review) => <button type="button" key={review.id} className={review.id === selectedReviewId ? 'is-selected' : undefined} onClick={() => selectReview(review.id)}>
                <span><strong>{review.reasonCodes[0] ?? '추가 확인 필요'}</strong><small>{new Date(review.createdAt).toLocaleString('ko-KR')}</small></span>
                <b>{statusLabel(review.status)}</b>
              </button>)}
              {reviewCursor ? <button type="button" className="ledger-review-browser__more" onClick={loadMoreReviews} disabled={reviewPageStatus === 'loading'}>
                {reviewPageStatus === 'loading' ? '검토 불러오는 중…' : '검토 더 보기'}
              </button> : null}
              {reviewPageStatus === 'error' ? <p role="alert">다음 검토 목록을 불러오지 못했습니다. 다시 시도해 주세요.</p> : null}
            </div>
            <div className="ledger-review-browser__detail">
              {reviewDetailStatus === 'loading' ? <p role="status">검토 상세를 불러오는 중입니다.</p> : null}
              {reviewDetailStatus === 'error' ? <p role="alert">검토 상세를 불러오지 못했습니다.</p> : null}
              {reviewDetailStatus === 'ready' && reviewDetail ? <article>
                <header><div><span>ACCOUNT REVIEW</span><h2>{reviewDetail.reasonCodes[0] ?? '추가 확인 필요'}</h2></div><b>{statusLabel(reviewDetail.status)}</b></header>
                <p>{reviewDetail.reasonCodes.join(' · ')}</p>
                <dl>
                  <div><dt>Review ID</dt><dd>{reviewDetail.id}</dd></div>
                  <div><dt>현재 revision</dt><dd>rev.{reviewDetail.revisionNumber} · {reviewDetail.revisionId}</dd></div>
                  <div><dt>Pointer</dt><dd>{String(reviewDetail.pointerVersion)}</dd></div>
                  <div><dt>연결된 관찰</dt><dd>{reviewDetail.observations.length}건</dd></div>
                </dl>
                <section className="ledger-review-evidence" aria-labelledby="review-evidence-heading">
                  <header>
                    <div><span>REVIEW EVIDENCE</span><h3 id="review-evidence-heading">응답할 거래 근거</h3></div>
                    <b>{reviewDetail.observations.length}건</b>
                  </header>
                  <p>아래 거래 식별자·시각·계정·자산 수량을 확인한 뒤 응답해 주세요.</p>
                  <ul>
                    {reviewDetail.observations.map((observation) => {
                      const quantity = formatReviewQuantity(
                        observation.quantity,
                        observation.hasAssetDecimals ? observation.assetDecimals : undefined,
                      )
                      return <li key={`${observation.fragmentId}:${observation.observationId}`}>
                        <div className="ledger-review-evidence__summary">
                          <strong>{observation.assetSymbol || observation.kind || '거래 근거'}</strong>
                          <b>{quantity}{observation.assetSymbol ? ` ${observation.assetSymbol}` : ''}</b>
                        </div>
                        <dl>
                          <div><dt>거래/원본 ID</dt><dd>{observation.nativeId || observation.originLinkId || observation.observationId}</dd></div>
                          <div><dt>발생 시각</dt><dd>{observation.occurredAt ? new Date(observation.occurredAt).toLocaleString('ko-KR') : '제공되지 않음'}</dd></div>
                          <div><dt>계정·지갑</dt><dd>{[observation.accountLabel, observation.accountLocator, observation.accountChainId].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
                          <div><dt>자산 식별자</dt><dd>{[observation.assetSymbol, observation.assetLocator].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
                          <div><dt>근거 유형</dt><dd>{[observation.domain, observation.kind].filter(Boolean).join(' · ') || observation.originKind || '제공되지 않음'}</dd></div>
                        </dl>
                      </li>
                    })}
                  </ul>
                </section>
                {reviewDetail.status === 'OPEN' ? <form className="ledger-review-form" onSubmit={submitResolution}>
                  <fieldset disabled={resolutionBusy || resolutionBlocked}>
                    <legend>이 거래를 어떻게 처리할까요?</legend>
                    {reviewDetail.options.map((option) => <label key={option.code}>
                      <input type="radio" name="resolutionCode" value={option.code} checked={resolutionCode === option.code} onChange={() => changeResolutionCode(option.code)} />
                      <span><strong>{option.label}</strong><small>{option.code}{option.requiresEvidence ? ' · 근거 설명 필수' : ''}</small></span>
                    </label>)}
                  </fieldset>
                  <label className="ledger-review-form__note">
                    <span>검토 메모{selectedOption?.requiresEvidence ? ' (필수)' : ' (선택)'}</span>
                    <textarea value={resolutionNote} onChange={(event) => changeResolutionNote(event.target.value)} maxLength={4000} required={selectedOption?.requiresEvidence} disabled={resolutionBusy || resolutionBlocked} placeholder="판단 근거나 거래 맥락을 남겨 주세요." />
                  </label>
                  <button type="submit" disabled={!resolutionCode || resolutionBusy || resolutionBlocked || Boolean(selectedOption?.requiresEvidence && !resolutionNote.trim())}>
                    {resolutionStatus === 'submitting' ? '응답 저장 중…' : resolutionStatus === 'refreshing' ? '최신 응답 불러오는 중…' : resolutionStatus === 'reanalyze' ? '운영 확인 필요' : '이 응답으로 검토 완료'}
                  </button>
                  {resolutionStatus === 'submitting' ? <p role="status">응답 revision과 ReviewRoom 전달 대기열을 안전하게 저장하는 중입니다.</p> : null}
                  {resolutionStatus === 'refreshing' ? <p role="status">다른 변경이 먼저 반영되어 최신 revision을 불러오는 중입니다.</p> : null}
                  {resolutionStatus === 'success' ? <p className="is-success" role="status">응답 revision과 ReviewRoom 전달 대기열 저장이 완료되었습니다.</p> : null}
                  {resolutionStatus === 'stale' ? <p role="alert">다른 변경이 먼저 반영되어 최신 revision을 다시 불러왔습니다. 응답을 확인해 다시 제출해 주세요.</p> : null}
                  {resolutionStatus === 'stale-error' ? <p role="alert">변경된 최신 revision을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.</p> : null}
                  {resolutionStatus === 'conflict' ? <p role="alert">이전 요청 키와 응답 내용이 달라 새 요청으로 다시 제출해야 합니다.</p> : null}
                  {resolutionStatus === 'reanalyze' ? <p role="alert">이 검토에는 해결에 필요한 분석 계보가 없어 응답을 저장하지 않았습니다. 운영팀이 DB migration과 cutover 상태를 확인해야 합니다.</p> : null}
                  {resolutionStatus === 'error' ? <p role="alert">응답을 저장하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.</p> : null}
                </form> : <p className="ledger-review-resolved" role="status">{resolutionStatus === 'success'
                  ? `응답 revision과 발행 대기열 저장이 완료되었습니다. (${reviewDetail.resolutionCode})`
                  : `이 검토는 ${reviewDetail.resolutionCode} 응답으로 완료되었습니다.`}</p>}
              </article> : null}
            </div>
          </section>
        ) : null}
      </main>
    </div>
  )
}
