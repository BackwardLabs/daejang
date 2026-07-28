import { useCallback, useEffect, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { AppLink } from '../../components/AppLink.tsx'
import { loadDashboard, loadLedger, loadReviews, type DashboardModel, type LedgerEventModel, type ReviewModel } from '../../api/productApi.ts'
import './dashboard.css'

const monthLabels = [
  '1월',
  '2월',
  '3월',
  '4월',
  '5월',
  '6월',
  '7월',
  '8월',
  '9월',
  '10월',
  '11월',
  '12월',
]

const count = (value: string | number | undefined) => Number(value ?? 0)
const eventTypeLabel: Record<string, string> = { TRADE: '거래', TRANSFER: '전송', SWAP: '스왑', REWARD: '보상', OTHER: '기타', UNKNOWN: '미분류' }

export function DashboardPage() {
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')
  const [dashboard, setDashboard] = useState<DashboardModel>()
  const [events, setEvents] = useState<LedgerEventModel[]>([])
  const [reviews, setReviews] = useState<ReviewModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')

  const refresh = useCallback(async (year: AppYear, signal?: AbortSignal) => {
    setStatus('loading')
    try {
      const [dashboardResult, ledgerResult, reviewResult] = await Promise.all([
        loadDashboard(year, signal), loadLedger(year, signal), loadReviews({ signal }),
      ])
      setDashboard(dashboardResult.dashboard); setEvents(ledgerResult.items); setReviews(reviewResult.items); setStatus('ready')
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error')
    }
  }, [])

  useEffect(() => { const controller = new AbortController(); void refresh(selectedYear, controller.signal); return () => controller.abort() }, [refresh, selectedYear])

  function handleYearChange(year: AppYear) {
    setSelectedYear(year)
    setSyncMessage('')
  }

  function handleSync() {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncMessage('서버의 최신 처리 상태를 확인하고 있습니다.')
    void refresh(selectedYear).then(() => setSyncMessage('최신 처리 상태를 불러왔습니다.')).finally(() => setIsSyncing(false))
  }

  const metrics = [
    {
      label: '전체 거래',
      value: `${count(dashboard?.transactionCount).toLocaleString()}건`,
      detail: '현재 원장 기준',
      tone: 'positive',
    },
    {
      label: '검토 필요',
      value: `${count(dashboard?.openReviewCount).toLocaleString()}건`,
      detail: count(dashboard?.openReviewCount) > 0 ? '확인이 필요한 항목' : '열린 검토 없음',
      tone: 'review',
    },
    {
      label: '연결 소스',
      value: `${count(dashboard?.sourceCount).toLocaleString()}개`,
      detail: '활성 데이터 소스',
      tone: 'neutral',
    },
    {
      label: '처리 완료',
      value: `${count(dashboard?.completedCount).toLocaleString()}건`,
      detail: `${count(dashboard?.exceptionCount).toLocaleString()}건 예외`,
      tone: 'positive',
    },
  ] as const
  const monthlyCounts = monthLabels.map((_, month) => events.filter((event) => new Date(event.effectiveAt).getUTCMonth() === month).length)
  const maxMonth = Math.max(...monthlyCounts, 1)
  const recentTransactions = events.slice(0, 6)

  return (
    <div className="dashboard-page product-shell">
      <AppSidebar
        activePage="dashboard"
        year={selectedYear}
        onYearChange={handleYearChange}
      />

      <main className="dashboard-main">
        <div className="dashboard-content">
          <section className="dashboard-intro" aria-labelledby="dashboard-title">
            <div>
              <p>LEDGER OVERVIEW</p>
              <h1 id="dashboard-title">세무 장부 요약</h1>
              <span>연결한 거래 기록을 검토하고 신고 준비 상태를 확인합니다.</span>
            </div>
            <div className="dashboard-intro__actions">
              <button
                type="button"
                className="dashboard-action dashboard-action--sync"
                disabled={isSyncing}
                title={dashboard?.lastSyncUpdatedAt ? `${new Date(dashboard.lastSyncUpdatedAt).toLocaleString('ko-KR')} 기준` : '최신 상태 조회'}
                onClick={handleSync}
              >
                <i aria-hidden="true" />
                {isSyncing
                  ? '불러오는 중…'
                  : '새로고침'}
              </button>
              <AppLink href="/reports" className="dashboard-action dashboard-action--outline">
                보고서 보기
              </AppLink>
              <AppLink href="/sources" className="dashboard-action dashboard-action--primary">
                거래 추가
              </AppLink>
            </div>
          </section>

          {status === 'error' ? <p className="dashboard-year-notice" role="alert">장부 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p> : null}

          <p
            className="dashboard-sync-message"
            role="status"
            aria-live="polite"
            hidden={!syncMessage}
          >
            {syncMessage}
          </p>

          <section className="dashboard-review-alert" aria-label="검토 대기 알림">
            <span aria-hidden="true">!</span>
            <p>
              <strong>{count(dashboard?.openReviewCount)}건</strong>의 거래가
              검토를 기다리고 있습니다. 근거를 연결하면 신고 준비도가 올라갑니다.
            </p>
            <AppLink href="/ledger">검토 필요</AppLink>
          </section>

          <section className="dashboard-metrics" aria-label="장부 핵심 지표">
            {metrics.map((metric) => (
              <article
                key={metric.label}
                className={metric.tone === 'review' ? 'is-review' : undefined}
              >
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <small className={`dashboard-tone--${metric.tone}`}>
                  {metric.detail}
                </small>
              </article>
            ))}
          </section>

          <section className="dashboard-workspace" aria-label="거래 흐름과 검토 큐">
            <article className="dashboard-chart-card">
              <header>
                <div>
                  <h2>월별 거래 흐름</h2>
                  <p>월별 처리 거래 건수</p>
                </div>
                <div className="dashboard-chart-legend" aria-label="차트 범례">
                  <span><i className="is-orange" />거래 건수</span>
                </div>
              </header>
              <div className="dashboard-chart" aria-label={`${selectedYear}년 월별 거래 흐름`}>
                {monthlyCounts.map((value, index) => (
                  <div key={monthLabels[index]}>
                    <i
                      className={value > 0 ? 'is-current' : undefined}
                      style={{ height: `${Math.max(4, Math.round(value / maxMonth * 100))}%` }}
                    />
                    <span>{monthLabels[index]}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="dashboard-review-queue">
              <header>
                <h2>검토 큐</h2>
                <AppLink href="/ledger">전체 보기 →</AppLink>
              </header>
              <ul>
                {reviews.slice(0, 3).map((item) => (
                  <li key={item.id}>
                    <span>
                      <strong>{item.reasonCodes[0] ?? '검토 필요'}</strong>
                      <small>{item.id}</small>
                    </span>
                    <b>{new Date(item.createdAt).toLocaleDateString('ko-KR')}</b>
                  </li>
                ))}
                {reviews.length === 0 ? <li><span><strong>열린 검토가 없습니다</strong><small>새로운 검토가 생기면 여기에 표시됩니다.</small></span></li> : null}
              </ul>
            </article>
          </section>

          <section className="dashboard-recent" aria-labelledby="dashboard-recent-title">
            <header>
              <h2 id="dashboard-recent-title">최근 거래</h2>
              <div aria-label="거래 필터">
                <button type="button">전체 자산</button>
                <button type="button">전체 상태</button>
                <button type="button">{selectedYear}.01.01–12.31</button>
                <button type="button">필터</button>
              </div>
            </header>
            <div className="dashboard-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">일시</th>
                    <th scope="col">유형</th>
                    <th scope="col">자산</th>
                    <th scope="col">수량</th>
                    <th scope="col">평가액</th>
                    <th scope="col">상태</th>
                    <th scope="col">근거</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTransactions.map((transaction) => {
                    const posting = transaction.postings[0]
                    return <tr key={transaction.eventId}>
                      <td>{new Date(transaction.effectiveAt).toLocaleString('ko-KR')}</td>
                      <td>{eventTypeLabel[transaction.eventType] ?? transaction.eventType}</td>
                      <td>{posting?.assetId ?? '—'}</td>
                      <td><strong>{posting?.quantity ?? '—'}</strong></td>
                      <td><strong>{posting?.fairValue ? `${posting.fairValue} ${posting.denomination}` : '—'}</strong></td>
                      <td>
                        <span className={`dashboard-status dashboard-status--${transaction.resolution === 'RESOLVED' ? 'complete' : 'review'}`}>
                          {transaction.resolution === 'RESOLVED' ? '완료' : '검토 필요'}
                        </span>
                      </td>
                      <td>{transaction.interpretationSupport}</td>
                    </tr>
                  })}
                  {status === 'ready' && recentTransactions.length === 0 ? <tr><td colSpan={7}>이 과세연도에 처리된 거래가 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
