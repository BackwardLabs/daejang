import { useEffect, useRef, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  createDashboardSyncSnapshot,
  dashboardCurrentYear,
  readDashboardSnapshot,
  type DashboardHolding,
  type DashboardSource,
} from '../../mocks/dashboard.ts'
import './dashboard.css'

function getSourceHoldings(sources: DashboardSource[]): DashboardHolding[] {
  return sources.map((source) => ({
    symbol: source.detail.startsWith('거래소') ? 'CEX' : 'EVM',
    name: source.name,
    quantity: `${source.assets.length}개 자산`,
    price: source.detail,
    value: source.value,
    change: source.change,
    changeTone: source.changeTone,
    source: source.share,
  }))
}

function SourceCard({ source }: { source: DashboardSource }) {
  return (
    <article className="dashboard-source-card">
      <div className="dashboard-source-card__heading">
        <div>
          <h3>{source.name}</h3>
          <p>{source.detail}</p>
        </div>
        <span>{source.share}</span>
      </div>

      <div className="dashboard-source-card__metric">
        <strong>{source.value}</strong>
        <span className={`dashboard-tone--${source.changeTone}`}>{source.change}</span>
      </div>

      <ul aria-label={`${source.name} 보유 자산`}>
        {source.assets.map((asset) => (
          <li key={asset.name}>
            <span className="dashboard-asset-name">
              <i style={{ backgroundColor: asset.color }} />
              {asset.name}
            </span>
            <span>{asset.amount}</span>
          </li>
        ))}
      </ul>
    </article>
  )
}

function HoldingsTable({
  rows,
  view,
}: {
  rows: DashboardHolding[]
  view: 'asset' | 'source'
}) {
  return (
    <div className="dashboard-table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">{view === 'asset' ? '자산' : '유형'}</th>
            <th scope="col">{view === 'asset' ? '보유수량' : '연결 정보'}</th>
            <th scope="col">{view === 'asset' ? '현재가' : '식별 정보'}</th>
            <th scope="col">평가금액</th>
            <th scope="col">미실현 손익</th>
            <th scope="col">{view === 'asset' ? '소스' : '비중'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((holding) => (
            <tr key={`${view}-${holding.symbol}-${holding.name}`}>
              <th scope="row">
                <strong>{holding.symbol}</strong>
                <span>{holding.name}</span>
              </th>
              <td>{holding.quantity}</td>
              <td>{holding.price}</td>
              <td>
                <strong>{holding.value}</strong>
              </td>
              <td className={`dashboard-tone--${holding.changeTone}`}>
                <strong>{holding.change}</strong>
              </td>
              <td>{holding.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DashboardPage() {
  const [holdingsView, setHoldingsView] = useState<'asset' | 'source'>('asset')
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')
  const [snapshot, setSnapshot] = useState(() => readDashboardSnapshot('2027'))
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState('')
  const syncTimerRef = useRef<number | undefined>(undefined)
  const sourceHoldings = getSourceHoldings(snapshot.sources)

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
    setSyncMessage('연결된 3개 소스를 동기화하고 있습니다.')
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

  return (
    <div className="dashboard-page">
      <AppSidebar
        activePage="dashboard"
        year={selectedYear}
        onYearChange={handleYearChange}
      />

      <main className="dashboard-main">
        <PageHeader
          actions={
            <>
              <span>{snapshot.lastSynced} 기준</span>
              <button
                type="button"
                className="dashboard-button dashboard-button--secondary"
                disabled={isSyncing || selectedYear !== dashboardCurrentYear}
                title={
                  selectedYear !== dashboardCurrentYear
                    ? '지난 과세연도는 동기화할 수 없습니다.'
                    : undefined
                }
                onClick={handleSync}
              >
                {isSyncing
                  ? '동기화 중…'
                  : selectedYear !== dashboardCurrentYear
                    ? '동기화 불가'
                    : '동기화'}
              </button>
              <a
                href="/app/sources"
                className="dashboard-button dashboard-button--primary"
              >
                소스 연결
              </a>
            </>
          }
          description="연결한 지갑·거래소의 보유 자산을 한눈에 확인합니다."
          eyebrow="DASHBOARD"
          title="대시보드"
          tone="dashboard"
        />
        {selectedYear !== dashboardCurrentYear && (
          <p className="dashboard-year-notice">
            {selectedYear}년은 마감된 과세연도입니다. 저장된 snapshot만
            조회할 수 있으며 새 동기화는 {dashboardCurrentYear}년에서
            가능합니다.
          </p>
        )}
        <p className="dashboard-sync-message" role="status" aria-live="polite">
          {syncMessage}
        </p>

        <section className="dashboard-summary" aria-label="포트폴리오 요약">
          <article className="dashboard-total-card">
            <div className="dashboard-total-card__heading">
              <h2>총 보유자산 (KRW 환산)</h2>
              <span>연결 소스 {snapshot.sources.length}곳</span>
            </div>
            <div className="dashboard-total-card__metric">
              <strong>{snapshot.totalAssets}</strong>
              <span>{snapshot.dailyChange}</span>
            </div>
            <p>최근 24시간 · 현재가 기준 평가액</p>
            <div className="dashboard-value-bars" aria-label="최근 7일 평가금액 상승 추이">
              {snapshot.bars.map((height, index) => (
                <i
                  key={height}
                  className={index === 6 ? 'is-current' : undefined}
                  style={{ height }}
                />
              ))}
            </div>
          </article>

          <article className="dashboard-allocation-card">
            <div className="dashboard-section-heading">
              <h2>자산 배분</h2>
              <span>평가금액 기준</span>
            </div>
            <div className="dashboard-allocation-bar" aria-hidden="true">
              {snapshot.allocations.map((asset) => (
                <i
                  key={asset.symbol}
                  style={{ backgroundColor: asset.color, width: `${asset.percent}%` }}
                />
              ))}
            </div>
            <ul>
              {snapshot.allocations.map((asset) => (
                <li key={asset.symbol}>
                  <span className="dashboard-asset-name">
                    <i style={{ backgroundColor: asset.color }} />
                    <strong>{asset.symbol}</strong>
                  </span>
                  <span>{asset.percent}%</span>
                  <span>·</span>
                  <span>{asset.amount}</span>
                </li>
              ))}
            </ul>
          </article>
        </section>

        <section className="dashboard-sources" aria-labelledby="dashboard-sources-title">
          <div className="dashboard-sources__heading">
            <h2 id="dashboard-sources-title">소스별 보유 현황</h2>
            <p>연결한 거래소와 지갑의 평가금액 및 주요 자산</p>
          </div>
          <div className="dashboard-source-grid">
            {snapshot.sources.map((source) => (
              <SourceCard key={source.name} source={source} />
            ))}
          </div>
        </section>

        <section className="dashboard-holdings" aria-labelledby="dashboard-holdings-title">
          <div className="dashboard-holdings__heading">
            <h2 id="dashboard-holdings-title">보유 자산</h2>
            <div className="dashboard-tabs" role="tablist" aria-label="보유 자산 분류">
              <button
                type="button"
                role="tab"
                aria-selected={holdingsView === 'asset'}
                onClick={() => setHoldingsView('asset')}
              >
                자산별
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={holdingsView === 'source'}
                onClick={() => setHoldingsView('source')}
              >
                소스별
              </button>
            </div>
          </div>
          <HoldingsTable
            view={holdingsView}
            rows={holdingsView === 'asset' ? snapshot.holdings : sourceHoldings}
          />
        </section>

        <p className="dashboard-disclaimer">
          보유 수량·평가금액은 연결한 지갑·거래소 데이터와 현재가 기준 참고
          수치이며, 예상 손익은 세무 검토용 장부 초안입니다. 최종 신고 전 등록
          세무대리인의 확인이 필요합니다.
        </p>
      </main>
    </div>
  )
}
