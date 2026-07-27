import { useEffect, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { createReport, loadReports, type ReportModel } from '../../api/productApi.ts'
import './report.css'

const number = (value: string | number) => Number(value).toLocaleString('ko-KR')

export function ReportPage() {
  const [year, setYear] = useState<AppYear>('2027')
  const [reports, setReports] = useState<ReportModel[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'creating'>('loading')

  const refresh = async (selectedYear: AppYear, signal?: AbortSignal) => {
    const result = await loadReports(selectedYear, signal); setReports(result.items); setSelectedId((current) => result.items.some((item) => item.id === current) ? current : result.items[0]?.id)
  }
  useEffect(() => { const controller = new AbortController(); setStatus('loading'); void refresh(year, controller.signal).then(() => setStatus('ready')).catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setStatus('error') }); return () => controller.abort() }, [year])
  const selected = reports.find((report) => report.id === selectedId)

  async function handleCreate() {
    setStatus('creating')
    try { const { report } = await createReport(year); await refresh(year); setSelectedId(report.id); setStatus('ready') } catch { setStatus('error') }
  }

  return <div className="ledger-page report-page product-shell">
    <AppSidebar activePage="reports" year={year} onYearChange={setYear} />
    <main className="report-main">
      <PageHeader actions={<button type="button" className="report-create-action" disabled={status === 'creating'} onClick={() => void handleCreate()}>{status === 'creating' ? '생성 중…' : '현재 장부로 보고서 생성'}</button>} description="Engine이 고정한 입력 digest와 결과 digest를 불변 snapshot으로 보관합니다." eyebrow="REPORTS" title="보고서" tone="workspace" />
      {status === 'error' ? <p className="report-api-state" role="alert">보고서를 처리하지 못했습니다. 장부와 Engine 상태를 확인해 주세요.</p> : null}
      {status === 'loading' ? <p className="report-api-state" role="status">보고서를 불러오는 중입니다.</p> : null}
      {status !== 'loading' && reports.length === 0 ? <section className="report-empty-state"><h2>아직 발행된 보고서가 없습니다</h2><p>현재 장부 상태를 기준으로 첫 번째 불변 snapshot을 생성할 수 있습니다.</p><button type="button" disabled={status === 'creating'} onClick={() => void handleCreate()}>보고서 생성</button></section> : null}
      {reports.length > 0 ? <div className="report-live-layout">
        <section className="report-live-history" aria-labelledby="report-history-title"><h2 id="report-history-title">발행 내역</h2>{reports.map((report) => <button type="button" key={report.id} className={report.id === selectedId ? 'is-active' : undefined} onClick={() => setSelectedId(report.id)}><span><strong>{report.taxYear}년 보고서</strong><small>{new Date(report.issuedAt).toLocaleString('ko-KR')}</small></span><b data-status={report.status}>{report.status === 'FINAL' ? '최종' : '부분'}</b></button>)}</section>
        {selected ? <article className="report-live-detail"><header><div><span>IMMUTABLE SNAPSHOT</span><h2>{selected.taxYear}년 보고서</h2></div><b data-status={selected.status}>{selected.status === 'FINAL' ? '최종' : '부분 산출'}</b></header><section className="report-live-metrics"><div><span>전체 거래</span><strong>{number(selected.transactionCount)}건</strong></div><div><span>완료</span><strong>{number(selected.completeCount)}건</strong></div><div><span>예외</span><strong>{number(selected.exceptionCount)}건</strong></div><div><span>손익</span><strong>{selected.status === 'PARTIAL' ? '산출 대기' : `${number(selected.profitAmount)} ${selected.denomination}`}</strong></div></section><h3>무결성 정보</h3><dl><div><dt>Report ID</dt><dd>{selected.id}</dd></div><div><dt>Input digest</dt><dd>{selected.inputDigest}</dd></div><div><dt>Result digest</dt><dd>{selected.resultDigest}</dd></div><div><dt>Manifest digest</dt><dd>{selected.manifestDigest}</dd></div><div><dt>Row digest</dt><dd>{selected.rowDigest}</dd></div></dl><p className="report-live-note">부분 산출은 세금 계산 결과가 확정되지 않았음을 뜻합니다. 가짜 손익을 표시하지 않고 입력과 예외 상태만 고정합니다.</p></article> : null}
      </div> : null}
    </main>
  </div>
}
