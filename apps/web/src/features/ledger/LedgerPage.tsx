import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { AppLink } from '../../components/AppLink.tsx'
import { ApiClientError } from '../../api/client.ts'
import {
  loadLedger,
  loadReview,
  loadReviews,
  resolveReview,
  type LedgerEventModel,
  type ReviewDetailModel,
  type ReviewModel,
} from '../../api/productApi.ts'
import './ledger.css'

const eventLabels: Record<string, string> = {
  TRADE: '거래', TRANSFER: '전송', SWAP: '스왑', BRIDGE: '브리지', REWARD: '보상',
  BORROW: '대여', REPAY: '상환', STAKE: '스테이킹', LIQUIDITY: '유동성', WRAP: '래핑',
  UNKNOWN: '미분류', OTHER: '기타',
}
const statusLabel = (value: string) => value === 'RESOLVED' ? '완료' : value === 'PARTIAL' ? '일부 확인' : '검토 필요'

export const formatReviewQuantity = (quantity: string, assetDecimals?: number) => {
  if (!/^-?\d+$/.test(quantity)) return quantity || '—'
  if (assetDecimals === undefined) return `${quantity} raw units`
  const negative = quantity.startsWith('-')
  const digits = negative ? quantity.slice(1) : quantity
  if (assetDecimals === 0) return `${negative ? '-' : ''}${digits}`
  const padded = digits.padStart(assetDecimals + 1, '0')
  const integer = padded.slice(0, -assetDecimals)
  const fraction = padded.slice(-assetDecimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

type LedgerSurface = 'ledger' | 'review'
type LedgerSurfaceStatus = 'loading' | 'error'

function LedgerDataState({
  surface,
  status,
  onRetry,
}: {
  surface: LedgerSurface
  status: LedgerSurfaceStatus
  onRetry: () => void
}) {
  const isLedger = surface === 'ledger'
  const isLoading = status === 'loading'
  const subject = isLedger ? '장부' : '검토 목록'
  const subjectObject = isLedger ? '장부를' : '검토 목록을'
  const retryLabel = isLedger ? '장부 다시 불러오기' : '검토 다시 불러오기'
  const listTitle = isLedger ? '거래 목록' : '검토 목록'
  const detailTitle = isLedger ? '거래 상세' : '검토 상세'
  const message = isLoading
    ? `${subjectObject} 불러오는 중입니다.`
    : `${subjectObject} 불러오지 못했습니다.`
  const description = isLoading
    ? '데이터가 도착하면 이 화면에 바로 표시됩니다. 다른 메뉴는 계속 사용할 수 있습니다.'
    : '연결 상태를 확인한 뒤 다시 시도해 주세요. 다른 메뉴는 계속 사용할 수 있습니다.'

  return <div className="ledger-data-state" aria-busy={isLoading}>
    <section
      className={`ledger-data-state__notice is-${status}`}
      role={isLoading ? 'status' : 'alert'}
      aria-live={isLoading ? 'polite' : 'assertive'}
    >
      <span className="ledger-data-state__icon" aria-hidden="true">{isLoading ? '···' : '!'}</span>
      <div><strong>{message}</strong><p>{description}</p></div>
      {!isLoading ? <button type="button" onClick={onRetry}>{retryLabel}</button> : null}
    </section>
    <section className="ledger-browser ledger-browser--state" aria-label={`${subject} ${isLoading ? '로딩' : '오류'} 상태`}>
      <div className="ledger-data-state__panel ledger-data-state__list">
        <header><div><span>LIST</span><h2>{listTitle}</h2></div><small>{isLoading ? '불러오는 중' : '연결 오류'}</small></header>
        {isLoading ? <div className="ledger-data-state__rows" aria-hidden="true">
          <i /><i /><i />
        </div> : <p>목록을 표시할 수 없습니다.</p>}
      </div>
      <div className="ledger-browser__detail ledger-data-state__panel">
        <header><div><span>DETAIL</span><h2>{detailTitle}</h2></div></header>
        {isLoading ? <div className="ledger-data-state__detail" aria-hidden="true"><i /><i /><i /><i /></div> : <p>목록을 다시 불러오면 상세 정보도 함께 복구됩니다.</p>}
      </div>
    </section>
  </div>
}

export function LedgerPage() {
  const [year, setYear] = useState<AppYear>('2027')
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
  const [ledgerReloadKey, setLedgerReloadKey] = useState(0)

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
  }, [ledgerReloadKey, year])

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

  const selected = useMemo(() => events.find((event) => event.eventId === selectedId), [events, selectedId])
  const selectedOption = reviewDetail?.options.find((option) => option.code === resolutionCode)
  const resolutionBusy = resolutionStatus === 'submitting' || resolutionStatus === 'refreshing'
  const resolutionBlocked = resolutionStatus === 'reanalyze'
  const ledgerCount = ledgerStatus === 'ready' ? events.length : '—'
  const reviewCount = reviewStatus === 'ready' ? reviews.length : '—'

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
        <section className="ledger-header">
          <div><p>ACTIVITY · LEDGER · REVIEW</p><h1>거래 장부</h1><span>Engine이 확정한 현재 revision과 열린 검토 항목을 조회합니다.</span></div>
          <div className="ledger-header__actions">
            <button type="button" className={view === 'ledger' ? 'is-active' : undefined} onClick={() => setView('ledger')}>거래 {ledgerCount}</button>
            <button type="button" className={view === 'review' ? 'is-active' : undefined} onClick={() => setView('review')}>검토 {reviewCount}</button>
          </div>
        </section>

        {view === 'ledger' && ledgerStatus !== 'ready' ? <LedgerDataState surface="ledger" status={ledgerStatus} onRetry={() => setLedgerReloadKey((current) => current + 1)} /> : null}

        {ledgerStatus === 'ready' && view === 'ledger' ? (
          events.length === 0 ? (
            <section className="ledger-empty-state"><h2>아직 처리된 거래가 없습니다</h2><p>데이터 소스를 등록하고 Sync Job이 완료되면 실제 거래가 여기에 표시됩니다.</p><AppLink href="/sources">데이터 소스 관리</AppLink></section>
          ) : (
            <section className="ledger-browser" aria-label="거래 장부">
              <div className="ledger-browser__list">
                {events.map((event) => <button type="button" key={event.eventId} className={event.eventId === selectedId ? 'is-selected' : undefined} onClick={() => setSelectedId(event.eventId)}>
                  <span><strong>{eventLabels[event.eventType] ?? event.eventType}</strong><small>{new Date(event.effectiveAt).toLocaleString('ko-KR')}</small></span>
                  <b data-status={event.resolution}>{statusLabel(event.resolution)}</b>
                </button>)}
              </div>
              {selected ? <article className="ledger-browser__detail">
                <header><div><span>EVENT</span><h2>{eventLabels[selected.eventType] ?? selected.eventType}</h2></div><b>{statusLabel(selected.resolution)}</b></header>
                <dl><div><dt>Event ID</dt><dd>{selected.eventId}</dd></div><div><dt>현재 revision</dt><dd>rev.{selected.revisionNumber} · {selected.revisionId}</dd></div><div><dt>해석 상태</dt><dd>{selected.interpretationSupport}</dd></div><div><dt>흐름</dt><dd>{selected.flowShape}</dd></div></dl>
                <h3>자산 변동</h3>
                {selected.postings.length ? <table><thead><tr><th>자산</th><th>방향</th><th>수량</th><th>역할</th><th>평가액</th></tr></thead><tbody>{selected.postings.map((posting) => <tr key={posting.legId}><td>{posting.assetId}</td><td>{posting.direction}</td><td>{posting.quantity}</td><td>{posting.role}</td><td>{posting.fairValue ? `${posting.fairValue} ${posting.denomination}` : '—'}</td></tr>)}</tbody></table> : <p>이 revision에 확정된 posting이 없습니다.</p>}
              </article> : null}
            </section>
          )
        ) : null}

        {view === 'review' && reviewStatus !== 'ready' ? <LedgerDataState surface="review" status={reviewStatus} onRetry={() => setReviewReloadKey((current) => current + 1)} /> : null}

        {reviewStatus === 'ready' && view === 'review' ? (
          reviews.length === 0 ? <section className="ledger-empty-state"><h2>열린 검토가 없습니다</h2><p>Engine이 판단 보류 항목을 만들면 사유와 근거가 여기에 표시됩니다.</p></section> :
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
