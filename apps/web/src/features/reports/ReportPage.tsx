import { useEffect, useState } from 'react'
import { ApiClientError } from '../../api/client.ts'
import { AppSidebar } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  loadAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import {
  loadCurrentTaxReport,
  loadTaxReportDetail,
  loadTaxReportHistory,
  type TaxReportDetailModel,
  type TaxReportModel,
} from './taxReportApi.ts'
import { TaxReportDetail } from './TaxReportDetail.tsx'
import './report.css'

const finalityLabel = (value: TaxReportModel['finality']) =>
  value === 'FINAL' ? '입력 확정' : '잠정 입력'

const calculationStatusLabel = (value: TaxReportModel['status']) =>
  value === 'FINAL' ? '계산 완료' : '부분 계산'

const filingStatusLabel = (
  value: TaxReportModel['filingStatus'],
  taxYear: number,
) => taxYear < 2027
  ? '신고용 아님'
  : value === 'READY' ? '신고 준비' : '신고 준비 불가'

const newestFirst = (left: TaxReportModel, right: TaxReportModel) => {
  const issuedAtDifference =
    Date.parse(right.issuedAt) - Date.parse(left.issuedAt)
  if (issuedAtDifference !== 0) return issuedAtDifference
  if (left.finality !== right.finality) {
    return left.finality === 'FINAL' ? -1 : 1
  }
  return String(right.pointerVersion).localeCompare(
    String(left.pointerVersion),
    undefined,
    { numeric: true },
  )
}

const mergeRevisions = (
  history: TaxReportModel[],
  ...currentReports: Array<TaxReportModel | null>
) => {
  const revisions = new Map<string, TaxReportModel>()
  for (const report of [...currentReports, ...history]) {
    if (report) revisions.set(report.reportId, report)
  }
  return [...revisions.values()].sort(newestFirst)
}

const loadOptionalCurrent = async (
  taxYear: string,
  finality: TaxReportModel['finality'],
  signal: AbortSignal,
) => {
  try {
    return (await loadCurrentTaxReport(taxYear, finality, signal)).report
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return null
    throw error
  }
}

export function ReportWorkspacePage() {
  const [year, setYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [currentReport, setCurrentReport] =
    useState<TaxReportModel | null>(null)
  const [revisions, setRevisions] = useState<TaxReportModel[]>([])
  const [selectedReportId, setSelectedReportId] = useState<string>()
  const [taxStatus, setTaxStatus] =
    useState<'error' | 'loading' | 'ready' | 'unsupported'>('loading')
  const [reportDetail, setReportDetail] =
    useState<TaxReportDetailModel | null>(null)
  const [detailStatus, setDetailStatus] =
    useState<'error' | 'idle' | 'loading' | 'not-found' | 'ready'>('idle')

  useEffect(() => {
    const controller = new AbortController()

    setCurrentReport(null)
    setRevisions([])
    setSelectedReportId(undefined)
    setReportDetail(null)
    setDetailStatus('idle')

    if (Number(year) < 2025) {
      setTaxStatus('unsupported')
      return () => controller.abort()
    }

    setTaxStatus('loading')
    void Promise.allSettled([
      loadOptionalCurrent(year, 'FINAL', controller.signal),
      loadOptionalCurrent(year, 'PROVISIONAL', controller.signal),
      loadTaxReportHistory(year, controller.signal),
    ])
      .then(([finalResult, provisionalResult, historyResult]) => {
        if (
          finalResult.status === 'rejected' &&
          provisionalResult.status === 'rejected' &&
          historyResult.status === 'rejected'
        ) {
          throw finalResult.reason
        }
        const finalReport =
          finalResult.status === 'fulfilled' ? finalResult.value : null
        const provisionalReport =
          provisionalResult.status === 'fulfilled'
            ? provisionalResult.value
            : null
        const history =
          historyResult.status === 'fulfilled'
            ? historyResult.value.items
            : []
        const availableCurrents = [
          finalReport,
          provisionalReport,
        ].filter((report): report is TaxReportModel => report !== null)
        const latestCurrent = availableCurrents.sort(newestFirst)[0] ?? null
        const availableRevisions = mergeRevisions(
          history,
          finalReport,
          provisionalReport,
        )

        setCurrentReport(latestCurrent)
        setRevisions(availableRevisions)
        setSelectedReportId(
          latestCurrent?.reportId ?? availableRevisions[0]?.reportId,
        )
        setTaxStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setTaxStatus('error')
        }
      })

    return () => controller.abort()
  }, [year])

  useEffect(() => {
    if (!selectedReportId) {
      setReportDetail(null)
      setDetailStatus('idle')
      return
    }

    const controller = new AbortController()
    setReportDetail(null)
    setDetailStatus('loading')
    void loadTaxReportDetail(selectedReportId, controller.signal)
      .then((result) => {
        setReportDetail(result.report)
        setDetailStatus('ready')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setDetailStatus(
          error instanceof ApiClientError && error.status === 404
            ? 'not-found'
            : 'error',
        )
      })

    return () => controller.abort()
  }, [selectedReportId])

  const selectedReport = revisions.find(
    (report) => report.reportId === selectedReportId,
  )

  function handleYearChange(nextYear: AppYear) {
    setYear(nextYear)
    saveAppYear(nextYear)
  }

  return (
    <div className="ledger-page report-page product-shell">
      <AppSidebar
        activePage="reports"
        year={year}
        onYearChange={handleYearChange}
      />
      <main className="report-main">
        <PageHeader
          description="Tax Engine이 발행한 계산 결과를 장부로 검토하고, 선택한 revision의 PDF를 생성합니다."
          eyebrow="TAX LEDGER"
          title="세무 장부"
          tone="workspace"
        />

        <section
          className="tax-report-section"
          aria-labelledby="tax-report-section-title"
        >
          <header>
            <div>
              <span>REPORT WORKSPACE</span>
              <h2 id="tax-report-section-title">
                {Number(year) < 2027
                  ? `${year}년 가상자산 세무 정책 시뮬레이션 장부`
                  : `${year}년 가상자산 세무 장부`}
              </h2>
            </div>
            <p>
              미확정 항목은 0원으로 대체하지 않으며, 장부 revision별 상태를
              그대로 보존합니다.
            </p>
          </header>

          {Number(year) < 2027 && taxStatus !== 'unsupported' ? (
            <aside
              className="tax-report-policy-simulation"
              aria-label="정책 시뮬레이션 안내"
            >
              <strong>POLICY_SIMULATION · 신고용 아님</strong>
              <p>
                {year}년 거래에 소득세법 제37조·제64조의3 및 시행령
                제88조의 2027.1.1 시행 예정 기준을 가정 적용한
                시뮬레이션입니다. 실제 신고 결과나 현행 세법 적용 결과로
                사용하지 마세요.
              </p>
            </aside>
          ) : null}

          {taxStatus === 'loading' ? (
            <p className="report-api-state" role="status">
              생성된 장부와 revision 이력을 불러오는 중입니다.
            </p>
          ) : null}
          {taxStatus === 'error' ? (
            <p className="report-api-state" role="alert">
              장부를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.
            </p>
          ) : null}
          {taxStatus === 'unsupported' ? (
            <p className="report-api-state">
              세무 장부는 2025년 이후 과세연도부터 제공됩니다.
            </p>
          ) : null}
          {taxStatus === 'ready' && revisions.length === 0 ? (
            <div className="report-empty-state">
              <h2>아직 생성된 장부가 없습니다</h2>
              <p>
                원장과 Lot 계산 결과가 발행되면 이 화면에 최신 장부가
                표시됩니다.
              </p>
            </div>
          ) : null}

          {revisions.length > 0 ? (
            <section
              className="tax-report-revisions"
              aria-labelledby="tax-report-revisions-title"
            >
              <header>
                <div>
                  <h3 id="tax-report-revisions-title">장부 revision</h3>
                  <p>
                    현재 장부와 이전 발행본을 전환해 비교할 수 있습니다.
                  </p>
                </div>
                {currentReport &&
                selectedReportId !== currentReport.reportId ? (
                  <button
                    type="button"
                    className="tax-report-revisions__latest"
                    onClick={() =>
                      setSelectedReportId(currentReport.reportId)
                    }
                  >
                    최신 장부로 이동
                  </button>
                ) : null}
              </header>
              <div className="tax-report-revisions__list">
                {revisions.map((report) => {
                  const isCurrent =
                    report.reportId === currentReport?.reportId
                  const isSelected = report.reportId === selectedReportId
                  return (
                    <button
                      type="button"
                      key={report.reportId}
                      className={isSelected ? 'is-active' : undefined}
                      aria-pressed={isSelected}
                      onClick={() => setSelectedReportId(report.reportId)}
                    >
                      <span>
                        <strong>
                          revision {String(report.pointerVersion)}
                          {isCurrent ? <em>현재</em> : null}
                        </strong>
                        <small>
                          {new Date(report.issuedAt).toLocaleString('ko-KR')}
                        </small>
                      </span>
                      <span
                        className="tax-report-badges"
                        aria-label="장부 revision 상태"
                      >
                        <b data-status={report.finality}>
                          {finalityLabel(report.finality)}
                        </b>
                        <b data-status={report.status}>
                          {calculationStatusLabel(report.status)}
                        </b>
                        <b
                          data-status={
                            report.taxYear < 2027
                              ? 'POLICY_SIMULATION'
                              : report.filingStatus
                          }
                        >
                          {filingStatusLabel(
                            report.filingStatus,
                            report.taxYear,
                          )}
                        </b>
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ) : null}

          {detailStatus === 'loading' ? (
            <p className="report-detail-state" role="status">
              선택한 장부의 상세 내역을 불러오는 중입니다.
            </p>
          ) : null}
          {detailStatus === 'not-found' ? (
            <p className="report-detail-state">
              장부 발행 이력은 확인했지만 상세 문서는 아직 준비되지
              않았습니다.
            </p>
          ) : null}
          {detailStatus === 'error' ? (
            <p className="report-detail-state is-error" role="alert">
              revision 이력은 유지되지만 선택한 상세 장부를 불러오지
              못했습니다.
            </p>
          ) : null}
          {detailStatus === 'ready' && reportDetail ? (
            <TaxReportDetail
              report={reportDetail}
              pointerVersion={selectedReport?.pointerVersion}
              isCurrent={selectedReportId === currentReport?.reportId}
            />
          ) : null}
        </section>
      </main>
    </div>
  )
}
