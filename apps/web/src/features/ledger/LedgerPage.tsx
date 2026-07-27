import { useEffect, useMemo, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { loadLedger, loadReviews, type LedgerEventModel, type ReviewModel } from '../../api/productApi.ts'
import './ledger.css'

const eventLabels: Record<string, string> = {
  TRADE: '거래', TRANSFER: '전송', SWAP: '스왑', BRIDGE: '브리지', REWARD: '보상',
  BORROW: '대여', REPAY: '상환', STAKE: '스테이킹', LIQUIDITY: '유동성', WRAP: '래핑',
  UNKNOWN: '미분류', OTHER: '기타',
}
const statusLabel = (value: string) => value === 'RESOLVED' ? '완료' : value === 'PARTIAL' ? '일부 확인' : '검토 필요'

export function LedgerPage() {
  const [year, setYear] = useState<AppYear>('2027')
  const [events, setEvents] = useState<LedgerEventModel[]>([])
  const [reviews, setReviews] = useState<ReviewModel[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [view, setView] = useState<'ledger' | 'review'>('ledger')
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    const controller = new AbortController(); setStatus('loading')
    void Promise.all([loadLedger(year, controller.signal), loadReviews(controller.signal)])
      .then(([ledger, review]) => { setEvents(ledger.items); setReviews(review.items); setSelectedId(ledger.items[0]?.eventId); setStatus('ready') })
      .catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error') })
    return () => controller.abort()
  }, [year])

  const selected = useMemo(() => events.find((event) => event.eventId === selectedId), [events, selectedId])

  return (
    <div className="ledger-page product-shell">
      <AppSidebar activePage="ledger" year={year} onYearChange={setYear} />
      <main className="ledger-main">
        <section className="ledger-header">
          <div><p>ACTIVITY · LEDGER · REVIEW</p><h1>거래 장부</h1><span>Engine이 확정한 현재 revision과 열린 검토 항목을 조회합니다.</span></div>
          <div className="ledger-header__actions">
            <button type="button" className={view === 'ledger' ? 'is-active' : undefined} onClick={() => setView('ledger')}>거래 {events.length}</button>
            <button type="button" className={view === 'review' ? 'is-active' : undefined} onClick={() => setView('review')}>검토 {reviews.length}</button>
          </div>
        </section>

        {status === 'error' ? <p className="ledger-api-state" role="alert">장부를 불러오지 못했습니다. Engine과 데이터베이스 연결을 확인해 주세요.</p> : null}
        {status === 'loading' ? <p className="ledger-api-state" role="status">장부를 불러오는 중입니다.</p> : null}

        {status === 'ready' && view === 'ledger' ? (
          events.length === 0 ? (
            <section className="ledger-empty-state"><h2>아직 처리된 거래가 없습니다</h2><p>데이터 소스를 등록하고 Sync Job이 완료되면 실제 거래가 여기에 표시됩니다.</p><a href="/sources">데이터 소스 관리</a></section>
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

        {status === 'ready' && view === 'review' ? (
          reviews.length === 0 ? <section className="ledger-empty-state"><h2>열린 검토가 없습니다</h2><p>Engine이 판단 보류 항목을 만들면 사유와 근거가 여기에 표시됩니다.</p></section> :
          <section className="ledger-review-list" aria-label="열린 검토">
            {reviews.map((review) => <article key={review.id}><header><span>OPEN REVIEW</span><strong>{new Date(review.createdAt).toLocaleString('ko-KR')}</strong></header><h2>{review.reasonCodes[0] ?? '추가 확인 필요'}</h2><p>{review.reasonCodes.join(' · ')}</p><dl><div><dt>Review ID</dt><dd>{review.id}</dd></div><div><dt>Revision</dt><dd>{review.revisionId}</dd></div><div><dt>Pointer</dt><dd>{String(review.pointerVersion)}</dd></div></dl></article>)}
          </section>
        ) : null}
      </main>
    </div>
  )
}
