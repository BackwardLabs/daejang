import { useEffect, useState } from 'react'
import { ApiClientError } from '../../api/client.ts'
import { loadReports, type ReportModel } from '../../api/productApi.ts'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  loadCurrentTaxReport,
  loadTaxReportHistory,
  type TaxAmountModel,
  type TaxReportModel,
} from './taxReportApi.ts'
import './report.css'

const number = (value: string | number) => Number(value).toLocaleString('ko-KR')

function decimal(value: string) {
  const [integer = '', fraction] = value.split('.', 2)
  const sign = integer.startsWith('-') ? '-' : ''
  const digits = sign ? integer.slice(1) : integer
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

function amountLabel(amount: TaxAmountModel, denomination: string) {
  if (amount.status === 'UNKNOWN' || !amount.hasAmount) return '미확정'
  if (amount.amount === undefined) return '표시 불가'
  return `${decimal(amount.amount)} ${denomination}`
}

function TaxAmount({
  amount,
  denomination,
  label,
}: {
  amount: TaxAmountModel
  denomination: string
  label: string
}) {
  return (
    <div data-certainty={amount.status}>
      <span>{label}</span>
      <strong>{amountLabel(amount, denomination)}</strong>
      <small>{amount.status}</small>
    </div>
  )
}

function CurrentTaxReport({ report }: { report: TaxReportModel }) {
  return (
    <article className="tax-report-current" aria-labelledby="tax-report-current-title">
      <header>
        <div>
          <span>CANONICAL CURRENT RESULT</span>
          <h2 id="tax-report-current-title">{report.taxYear}년 현재 세금 계산 결과</h2>
        </div>
        <div className="tax-report-badges" aria-label="현재 세금 보고서 상태">
          <b data-status={report.finality}>{report.finality}</b>
          <b data-status={report.status}>{report.status}</b>
          <b data-status={report.filingStatus}>{report.filingStatus}</b>
        </div>
      </header>

      <section className="tax-report-amounts" aria-label="세금 계산 금액">
        <TaxAmount amount={report.gainLoss} denomination={report.denominationAssetId} label="양도 손익" />
        <TaxAmount amount={report.taxableBase} denomination={report.denominationAssetId} label="과세표준" />
        <TaxAmount amount={report.nationalTax} denomination={report.denominationAssetId} label="국세" />
        <TaxAmount amount={report.localTax} denomination={report.denominationAssetId} label="지방세" />
        <TaxAmount amount={report.totalTax} denomination={report.denominationAssetId} label="총 세액" />
      </section>

      <dl className="tax-report-facts">
        <div><dt>처분</dt><dd>{number(report.counts.disposals)}건</dd></div>
        <div><dt>이체</dt><dd>{number(report.counts.transfers)}건</dd></div>
        <div><dt>제외 전환</dt><dd>{number(report.counts.excludedConversions)}건</dd></div>
        <div><dt>제한사항</dt><dd>{number(report.counts.limitations)}건</dd></div>
        <div><dt>Report ID</dt><dd>{report.reportId}</dd></div>
        <div><dt>Pointer version</dt><dd>{String(report.pointerVersion)}</dd></div>
      </dl>

      {report.filingStatus === 'BLOCKED' ? (
        <p className="tax-report-notice" role="status">
          현재 결과에는 미확정 금액 또는 coverage 제한이 있어 신고 준비 상태가 아닙니다.
          미확정 값을 0원으로 간주하지 않습니다.
        </p>
      ) : null}
    </article>
  )
}

export function ReportPage() {
  const [year, setYear] = useState<AppYear>('2027')
  const [reports, setReports] = useState<ReportModel[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [artifactStatus, setArtifactStatus] = useState<'error' | 'loading' | 'ready'>('loading')
  const [currentReport, setCurrentReport] = useState<TaxReportModel | null>(null)
  const [taxHistory, setTaxHistory] = useState<TaxReportModel[]>([])
  const [taxStatus, setTaxStatus] = useState<'error' | 'loading' | 'ready' | 'unsupported'>('loading')

  useEffect(() => {
    const controller = new AbortController()
    setArtifactStatus('loading')
    void loadReports(year, controller.signal)
      .then((result) => {
        setReports(result.items)
        setSelectedId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id)
        setArtifactStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setArtifactStatus('error')
      })

    if (Number(year) < 2027) {
      setCurrentReport(null)
      setTaxHistory([])
      setTaxStatus('unsupported')
      return () => controller.abort()
    }

    setTaxStatus('loading')
    const current = loadCurrentTaxReport(year, controller.signal)
      .then((result) => result.report)
      .catch((error: unknown) => {
        if (error instanceof ApiClientError && error.status === 404) return null
        throw error
      })
    void Promise.all([current, loadTaxReportHistory(year, controller.signal)])
      .then(([report, history]) => {
        setCurrentReport(report)
        setTaxHistory(history.items)
        setTaxStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setTaxStatus('error')
      })
    return () => controller.abort()
  }, [year])

  const selected = reports.find((report) => report.id === selectedId)

  return (
    <div className="ledger-page report-page product-shell">
      <AppSidebar activePage="reports" year={year} onYearChange={setYear} />
      <main className="report-main">
        <PageHeader
          description="현재 세금 계산 결과와 발행된 불변 산출물을 구분해 확인합니다."
          eyebrow="REPORTS"
          title="보고서"
          tone="workspace"
        />

        <section className="tax-report-section" aria-labelledby="tax-report-section-title">
          <header>
            <div>
              <span>LIVE TAX RESULT</span>
              <h2 id="tax-report-section-title">현재 세금 계산</h2>
            </div>
            <p>Tax Engine의 canonical current 포인터를 조회합니다.</p>
          </header>
          {taxStatus === 'loading' ? <p className="report-api-state" role="status">현재 세금 계산 결과를 불러오는 중입니다.</p> : null}
          {taxStatus === 'error' ? <p className="report-api-state" role="alert">현재 세금 계산 결과를 불러오지 못했습니다.</p> : null}
          {taxStatus === 'unsupported' ? <p className="report-api-state">현재 세금 계산 결과는 2027년 이후 과세연도부터 제공됩니다.</p> : null}
          {taxStatus === 'ready' && !currentReport ? <p className="report-api-state">아직 생성된 현재 세금 계산 결과가 없습니다.</p> : null}
          {currentReport ? <CurrentTaxReport report={currentReport} /> : null}
          {taxHistory.length > 0 ? (
            <section className="tax-report-history" aria-labelledby="tax-report-history-title">
              <h3 id="tax-report-history-title">세금 계산 이력</h3>
              <ul>
                {taxHistory.map((report) => (
                  <li key={report.reportId}>
                    <span><strong>{report.reportId}</strong><small>{new Date(report.issuedAt).toLocaleString('ko-KR')}</small></span>
                    <span className="tax-report-badges"><b data-status={report.finality}>{report.finality}</b><b data-status={report.filingStatus}>{report.filingStatus}</b></span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </section>

        <section className="artifact-report-section" aria-labelledby="artifact-report-title">
          <header>
            <div><span>IMMUTABLE ARTIFACTS</span><h2 id="artifact-report-title">발행 산출물 이력</h2></div>
            <p>입력·결과 digest가 고정된 별도 snapshot입니다.</p>
          </header>
          {artifactStatus === 'error' ? <p className="report-api-state" role="alert">발행 산출물을 불러오지 못했습니다.</p> : null}
          {artifactStatus === 'loading' ? <p className="report-api-state" role="status">발행 산출물을 불러오는 중입니다.</p> : null}
          {artifactStatus === 'ready' && reports.length === 0 ? <div className="report-empty-state"><h2>아직 발행된 산출물이 없습니다</h2><p>세금 계산 결과와 별개로 발행한 불변 snapshot이 여기에 표시됩니다.</p></div> : null}
          {reports.length > 0 ? <div className="report-live-layout">
            <section className="report-live-history" aria-labelledby="report-history-title"><h2 id="report-history-title">발행 내역</h2>{reports.map((report) => <button type="button" key={report.id} className={report.id === selectedId ? 'is-active' : undefined} onClick={() => setSelectedId(report.id)}><span><strong>{report.taxYear}년 산출물</strong><small>{new Date(report.issuedAt).toLocaleString('ko-KR')}</small></span><b data-status={report.status}>{report.status === 'FINAL' ? '최종' : '부분'}</b></button>)}</section>
            {selected ? <article className="report-live-detail"><header><div><span>IMMUTABLE SNAPSHOT</span><h2>{selected.taxYear}년 발행 산출물</h2></div><b data-status={selected.status}>{selected.status === 'FINAL' ? '최종' : '부분 산출'}</b></header><section className="report-live-metrics"><div><span>전체 거래</span><strong>{number(selected.transactionCount)}건</strong></div><div><span>완료</span><strong>{number(selected.completeCount)}건</strong></div><div><span>예외</span><strong>{number(selected.exceptionCount)}건</strong></div><div><span>손익</span><strong>{selected.status === 'PARTIAL' ? '산출 대기' : `${number(selected.profitAmount)} ${selected.denomination}`}</strong></div></section><h3>무결성 정보</h3><dl><div><dt>Report ID</dt><dd>{selected.id}</dd></div><div><dt>Input digest</dt><dd>{selected.inputDigest}</dd></div><div><dt>Result digest</dt><dd>{selected.resultDigest}</dd></div><div><dt>Manifest digest</dt><dd>{selected.manifestDigest}</dd></div><div><dt>Row digest</dt><dd>{selected.rowDigest}</dd></div></dl><p className="report-live-note">부분 산출은 계산 결과가 확정되지 않았음을 뜻합니다. 가짜 손익을 표시하지 않고 입력과 예외 상태만 고정합니다.</p></article> : null}
          </div> : null}
        </section>
      </main>
    </div>
  )
}
