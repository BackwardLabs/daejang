import { useCallback, useEffect, useState } from 'react'
import { AppSidebar } from '../../components/AppSidebar.tsx'
import { AppLink } from '../../components/AppLink.tsx'
import {
  loadDashboard,
  loadAllLedger,
  type DashboardModel,
  type LedgerEventModel,
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
  formatLedgerMoney,
  formatLedgerQuantity,
  formatUserFacingAssetSymbol,
  parseLedgerAsset,
} from '../ledger/ledgerPresentation.ts'
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
const feeRoles = new Set(['FEE', 'GAS'])

const postingAsset = (posting: LedgerEventModel['postings'][number]) =>
  parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )

export function DashboardPage() {
  const [selectedYear, setSelectedYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [dashboard, setDashboard] = useState<DashboardModel>()
  const [events, setEvents] = useState<LedgerEventModel[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [isSyncing, setIsSyncing] = useState(false)
  const [syncFeedback, setSyncFeedback] = useState<{
    message: string
    tone: 'error' | 'status'
  }>()

  const refresh = useCallback(async (year: AppYear, signal?: AbortSignal) => {
    setStatus('loading')
    try {
      const [dashboardResult, ledgerResult] = await Promise.all([
        loadDashboard(year, signal),
        loadAllLedger(year, { signal }),
      ])
      setDashboard(dashboardResult.dashboard)
      setEvents(ledgerResult.items)
      setStatus('ready')
      return true
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus('error')
      }
      return false
    }
  }, [])

  useEffect(() => { const controller = new AbortController(); void refresh(selectedYear, controller.signal); return () => controller.abort() }, [refresh, selectedYear])

  function handleYearChange(year: AppYear) {
    setSelectedYear(year)
    saveAppYear(year)
    setSyncFeedback(undefined)
  }

  async function handleSync() {
    if (isSyncing) return
    setIsSyncing(true)
    setSyncFeedback({
      message: '서버의 최신 처리 상태를 확인하고 있습니다.',
      tone: 'status',
    })
    const succeeded = await refresh(selectedYear)
    setSyncFeedback(
      succeeded
        ? {
            message: '최신 처리 상태를 불러왔습니다.',
            tone: 'status',
          }
        : {
            message:
              '최신 처리 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.',
            tone: 'error',
          },
    )
    setIsSyncing(false)
  }

  const openReviewCount = count(dashboard?.openReviewCount)
  const readyValue = (value: string) => status === 'ready' ? value : '—'
  const pendingDetail = status === 'loading' ? '불러오는 중' : '확인 필요'
  const metrics = [
    {
      label: '전체 거래',
      value: readyValue(
        `${count(dashboard?.transactionCount).toLocaleString()}건`,
      ),
      detail: status === 'ready' ? '현재 원장 기준' : pendingDetail,
      tone: 'positive',
    },
    {
      label: '검토 필요',
      value: readyValue(`${openReviewCount.toLocaleString()}건`),
      detail: status !== 'ready'
        ? pendingDetail
        : openReviewCount > 0
          ? '확인이 필요한 항목'
          : '검토 완료',
      tone:
        status === 'ready' && openReviewCount === 0
          ? 'positive'
          : 'review',
    },
    {
      label: '연결 소스',
      value: readyValue(
        `${count(dashboard?.sourceCount).toLocaleString()}개`,
      ),
      detail: status === 'ready' ? '활성 데이터 소스' : pendingDetail,
      tone: 'neutral',
    },
    {
      label: '처리 완료',
      value: readyValue(
        `${count(dashboard?.completedCount).toLocaleString()}건`,
      ),
      detail: status === 'ready'
        ? `${count(dashboard?.exceptionCount).toLocaleString()}건 예외`
        : pendingDetail,
      tone: 'positive',
    },
  ] as const
  const monthlyCounts = monthLabels.map((_, month) => events.filter((event) => new Date(event.effectiveAt).getUTCMonth() === month).length)
  const maxMonth = Math.max(...monthlyCounts, 1)
  const recentTransactions = events.slice(0, 6)
  const now = new Date()
  const selectedYearNumber = Number(selectedYear)
  const isFutureMonth = (month: number) => selectedYearNumber > now.getFullYear()
    || (selectedYearNumber === now.getFullYear() && month > now.getMonth())

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
              <AppLink href="/sources" className="dashboard-action dashboard-action--secondary">
                데이터 소스 추가
              </AppLink>
              <AppLink href="/reports" className="dashboard-action dashboard-action--primary">
                보고서 보기
              </AppLink>
            </div>
          </section>

          {status === 'error' ? <p className="dashboard-year-notice" role="alert">장부 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p> : null}

          {syncFeedback ? (
            <p
              className={`dashboard-sync-message is-${syncFeedback.tone}`}
              role={syncFeedback.tone === 'error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              {syncFeedback.message}
            </p>
          ) : null}

          <section
            className={`dashboard-review-alert ${
              status === 'ready' && openReviewCount === 0
                ? 'is-complete'
                : ''
            }`}
            aria-label="검토 현황"
            data-state={
              status === 'ready' && openReviewCount === 0
                ? 'complete'
                : status
            }
          >
            <span aria-hidden="true">
              {status === 'ready' && openReviewCount === 0 ? '✓' : '!'}
            </span>
            {status === 'loading' ? (
              <p>검토 현황을 불러오는 중입니다.</p>
            ) : status === 'error' ? (
              <p>검토 현황을 확인하지 못했습니다.</p>
            ) : openReviewCount === 0 ? (
              <p>
                <strong>검토 대기 항목이 없습니다.</strong> 현재 장부의 검토가
                모두 완료되었습니다.
              </p>
            ) : (
              <p>
                <strong>{openReviewCount}건</strong>의 거래가 검토를 기다리고
                있습니다. 근거를 연결하면 신고 준비도가 올라갑니다.
              </p>
            )}
            {status === 'ready' && openReviewCount > 0 ? (
              <AppLink href="/ledger">검토 필요</AppLink>
            ) : null}
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

          <section
            className="dashboard-workspace"
            aria-label={`${selectedYear}년 거래 흐름과 검토 현황`}
          >
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
                {monthlyCounts.map((value, index) => {
                  const futureMonth = isFutureMonth(index)
                  const description = futureMonth
                    ? `${monthLabels[index]} 아직 집계 기간 전`
                    : `${monthLabels[index]} 거래 ${value.toLocaleString()}건`
                  return <div key={monthLabels[index]} title={description}>
                    <strong className="dashboard-chart__value">
                      {futureMonth ? '예정' : `${value.toLocaleString()}건`}
                    </strong>
                    <i
                      className={futureMonth ? 'is-future' : value > 0 ? 'is-current' : undefined}
                      style={{ height: futureMonth ? '2px' : `${Math.max(4, Math.round(value / maxMonth * 100))}%` }}
                    />
                    <span>{monthLabels[index]}</span>
                  </div>
                })}
              </div>
            </article>

            <article className="dashboard-review-queue">
              <header>
                <h2>{selectedYear}년 검토 현황</h2>
                {status === 'ready' && openReviewCount > 0 ? (
                  <AppLink href="/ledger">검토 목록 보기 →</AppLink>
                ) : null}
              </header>
              <ul>
                {status === 'loading' ? (
                  <li>
                    <span>
                      <strong>검토 현황을 불러오는 중입니다</strong>
                      <small>잠시만 기다려 주세요.</small>
                    </span>
                  </li>
                ) : null}
                {status === 'error' ? (
                  <li>
                    <span>
                      <strong>검토 현황을 확인하지 못했습니다</strong>
                      <small>새로고침으로 다시 확인해 주세요.</small>
                    </span>
                  </li>
                ) : null}
                {status === 'ready' && openReviewCount > 0 ? (
                  <li>
                    <span>
                      <strong>
                        확인이 필요한 거래가 {openReviewCount.toLocaleString()}건
                        있습니다
                      </strong>
                      <small>
                        거래 장부에서 사유와 근거를 확인해 주세요.
                      </small>
                    </span>
                  </li>
                ) : null}
                {status === 'ready' && openReviewCount === 0 ? (
                  <li>
                    <span>
                      <strong>검토가 모두 완료되었습니다</strong>
                      <small>
                        이 조회 연도에는 확인이 필요한 거래가 없습니다.
                      </small>
                    </span>
                  </li>
                ) : null}
              </ul>
            </article>
          </section>

          <section className="dashboard-recent" aria-labelledby="dashboard-recent-title">
            <header>
              <div>
                <h2 id="dashboard-recent-title">최근 거래</h2>
                <p>{selectedYear}년 최신 {recentTransactions.length}건</p>
              </div>
              <AppLink href="/ledger">전체 장부 보기 →</AppLink>
            </header>
            <div className="dashboard-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">일시</th>
                    <th scope="col">거래</th>
                    <th scope="col">자산 변화</th>
                    <th scope="col">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {recentTransactions.map((transaction) => {
                    const materialPostings = transaction.postings.filter((posting) => !feeRoles.has(posting.role))
                    const posting = materialPostings[0] ?? transaction.postings[0]
                    const asset = posting ? postingAsset(posting) : undefined
                    const displayAssetSymbol = formatUserFacingAssetSymbol(asset?.symbol)
                    const quantity = posting && asset
                      ? formatLedgerQuantity(posting.quantity, asset.decimals)
                      : '—'
                    const fairValue = posting?.fairValue
                      ? formatLedgerMoney(
                          posting.fairValue,
                          posting.denomination,
                          transaction.postings,
                        )
                      : '—'
                    const additionalAssetCount = Math.max(0, materialPostings.length - 1)
                    const action = describeLedgerAction(
                      transaction.eventType,
                      transaction.flowShape,
                      transaction.postings,
                      transaction.subtype,
                    )
                    const source = describeLedgerSource(transaction.postings)
                    return <tr key={transaction.eventId}>
                      <td>
                        <time dateTime={transaction.effectiveAt}>
                          {new Date(transaction.effectiveAt).toLocaleDateString('ko-KR')}
                          <small>{new Date(transaction.effectiveAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</small>
                        </time>
                      </td>
                      <td>
                        <span className="dashboard-transaction">
                          <strong>{action.label}</strong>
                          <small>{source.label}</small>
                        </span>
                      </td>
                      <td>
                        <span className="dashboard-asset-change" title={posting?.assetId}>
                          <strong>{quantity}{asset?.decimals !== undefined ? ` ${displayAssetSymbol}` : ''}</strong>
                          <small>
                            {posting ? describePostingDirection(posting.direction) : '자산 확인 필요'}
                            {additionalAssetCount > 0 ? ` · 외 ${additionalAssetCount}개` : ''}
                            {fairValue !== '—' ? ` · ${fairValue}` : ''}
                          </small>
                        </span>
                      </td>
                      <td>
                        <span className={`dashboard-status dashboard-status--${transaction.resolution === 'RESOLVED' ? 'complete' : 'review'}`}>
                          {transaction.resolution === 'RESOLVED' ? '완료' : '일부 확인'}
                        </span>
                      </td>
                    </tr>
                  })}
                  {status === 'ready' && recentTransactions.length === 0 ? <tr><td colSpan={4}>이 조회 연도에 처리된 거래가 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
