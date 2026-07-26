import { useEffect, useRef, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import {
  createDashboardSyncSnapshot,
  dashboardCurrentYear,
  readDashboardSnapshot,
} from '../../mocks/dashboard.ts'
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

const reviewQueue = [
  { title: 'ETH 입금', detail: '취득가액 확인', amount: '₩ 1,240,000' },
  { title: 'Upbit 매도', detail: '거래소 원장 대조', amount: '₩ 860,000' },
  { title: 'USDC 전송', detail: '지갑 간 이전', amount: '₩ 530,000' },
]

const recentTransactions = [
  {
    date: '12.18 14:22',
    type: '매도',
    asset: 'ETH',
    quantity: '0.80',
    value: '₩ 3,142,000',
    status: '검토 필요',
    statusTone: 'review',
    evidence: '거래소 원장',
  },
  {
    date: '12.17 09:18',
    type: '입금',
    asset: 'USDC',
    quantity: '1,250',
    value: '₩ 1,710,000',
    status: '완료',
    statusTone: 'complete',
    evidence: '지갑 해시',
  },
  {
    date: '12.15 22:04',
    type: '스왑',
    asset: 'ARB → ETH',
    quantity: '2,100',
    value: '₩ 2,084,000',
    status: '완료',
    statusTone: 'complete',
    evidence: '온체인',
  },
  {
    date: '12.12 11:37',
    type: '출금',
    asset: 'BTC',
    quantity: '0.021',
    value: '₩ 2,860,000',
    status: '검토 필요',
    statusTone: 'review',
    evidence: '미연결',
  },
] as const

export function DashboardPage() {
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')
  const [snapshot, setSnapshot] = useState(() => readDashboardSnapshot('2027'))
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const syncTimerRef = useRef<number | undefined>(undefined)

  useEffect(
    () => () => {
      window.clearTimeout(syncTimerRef.current)
    },
    [],
  )

  function handleYearChange(year: AppYear) {
    setSelectedYear(year)
    setSnapshot(readDashboardSnapshot(year))
    setSyncMessage(`${year}년 장부 데이터를 불러왔습니다.`)
  }

  function handleSync() {
    if (isSyncing || selectedYear !== dashboardCurrentYear) return

    setIsSyncing(true)
    setSyncMessage('연결된 거래소와 지갑 기록을 동기화하고 있습니다.')
    window.clearTimeout(syncTimerRef.current)
    syncTimerRef.current = window.setTimeout(() => {
      const syncedSnapshot = createDashboardSyncSnapshot()
      setSnapshot(syncedSnapshot)
      setIsSyncing(false)
      setSyncMessage(
        `동기화가 완료되었습니다. 마지막 동기화 시각을 ${syncedSnapshot.lastSynced}(으)로 갱신했습니다.`,
      )
    }, 700)
  }

  const metrics = [
    {
      label: '전체 거래',
      value: selectedYear === '2027' ? '1,284건' : '1,097건',
      detail: selectedYear === '2027' ? '+42건 · 최근 7일' : '마감된 장부',
      tone: 'positive',
    },
    {
      label: '검토 필요',
      value: selectedYear === '2027' ? '12건' : '0건',
      detail: selectedYear === '2027' ? '우선 확인이 필요해요' : '검토 완료',
      tone: 'review',
    },
    {
      label: '예상 취득가액',
      value: snapshot.totalAssets,
      detail: '동기화 기준 추정값',
      tone: 'neutral',
    },
    {
      label: '근거 연결률',
      value: selectedYear === '2027' ? '92.4%' : '100%',
      detail: selectedYear === '2027' ? '+3.1% · 이번 주' : '마감 기준',
      tone: 'positive',
    },
  ] as const

  return (
    <div className="dashboard-page product-shell">
      <AppSidebar
        activePage="dashboard"
        year={selectedYear}
        onYearChange={handleYearChange}
      />

      <main className="dashboard-main">
        <header className="dashboard-topbar">
          <nav aria-label="현재 위치" className="dashboard-breadcrumb">
            <a href="/">Daejang</a>
            <span aria-hidden="true">/</span>
            <strong>대시보드</strong>
          </nav>
          <div className="dashboard-topbar__actions">
            <button
              type="button"
              className="dashboard-sync-status"
              disabled={isSyncing || selectedYear !== dashboardCurrentYear}
              title={`${snapshot.lastSynced} 기준`}
              onClick={handleSync}
            >
              <i aria-hidden="true" />
              {isSyncing
                ? '동기화 중…'
                : selectedYear === dashboardCurrentYear
                  ? '방금 동기화'
                  : '마감된 연도'}
            </button>
            <span className="dashboard-year-chip">{selectedYear} 과세연도</span>
            <span className="dashboard-topbar__avatar" aria-hidden="true" />
          </div>
        </header>

        <div className="dashboard-content">
          <section className="dashboard-intro" aria-labelledby="dashboard-title">
            <div>
              <p>LEDGER OVERVIEW</p>
              <h1 id="dashboard-title">세무 장부 요약</h1>
              <span>연결한 거래 기록을 검토하고 신고 준비 상태를 확인합니다.</span>
            </div>
            <div className="dashboard-intro__actions">
              <a href="/app/reports" className="dashboard-action dashboard-action--outline">
                보고서 보기
              </a>
              <a href="/app/sources" className="dashboard-action dashboard-action--primary">
                거래 추가
              </a>
            </div>
          </section>

          {selectedYear !== dashboardCurrentYear && (
            <p className="dashboard-year-notice">
              {selectedYear}년은 마감된 과세연도입니다. 저장된 snapshot만 조회할
              수 있습니다.
            </p>
          )}

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
              <strong>{selectedYear === '2027' ? '12건' : '0건'}</strong>의 거래가
              검토를 기다리고 있습니다. 근거를 연결하면 신고 준비도가 올라갑니다.
            </p>
            <a href="/app/ledger">검토 필요</a>
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
                  <p>총 거래액과 검토 완료 추이</p>
                </div>
                <div className="dashboard-chart-legend" aria-label="차트 범례">
                  <span><i className="is-orange" />거래액</span>
                  <span><i />검토 완료</span>
                </div>
              </header>
              <div className="dashboard-chart" aria-label={`${selectedYear}년 월별 거래 흐름`}>
                {snapshot.bars.map((height, index) => (
                  <div key={monthLabels[index]}>
                    <i
                      className={index === snapshot.bars.length - 1 ? 'is-current' : undefined}
                      style={{ height }}
                    />
                    <span>{monthLabels[index]}</span>
                  </div>
                ))}
              </div>
            </article>

            <article className="dashboard-review-queue">
              <header>
                <h2>검토 큐</h2>
                <a href="/app/ledger">전체 보기 →</a>
              </header>
              <ul>
                {reviewQueue.map((item) => (
                  <li key={item.title}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </span>
                    <b>{item.amount}</b>
                  </li>
                ))}
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
                  {recentTransactions.map((transaction) => (
                    <tr key={`${transaction.date}-${transaction.asset}`}>
                      <td>{transaction.date}</td>
                      <td>{transaction.type}</td>
                      <td>{transaction.asset}</td>
                      <td><strong>{transaction.quantity}</strong></td>
                      <td><strong>{transaction.value}</strong></td>
                      <td>
                        <span className={`dashboard-status dashboard-status--${transaction.statusTone}`}>
                          {transaction.status}
                        </span>
                      </td>
                      <td>{transaction.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
