import { useEffect, useRef, useState } from 'react'
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
  loadTaxReportGenerationStatus,
  loadTaxReportHistory,
  type AnyTaxReportDetailModel,
  type TaxReportGenerationStatusModel,
  type TaxReportModel,
} from './taxReportApi.ts'
import { TaxReportDetail } from './TaxReportDetail.tsx'
import { TaxReportDetailV2 } from './TaxReportDetailV2.tsx'
import './report.css'

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
  // History currently carries pointerVersion=0 because pointerVersion belongs to
  // the current pointer, not to an intrinsic historical revision. Insert current
  // pointers last so their authoritative pointer version wins for duplicate IDs.
  for (const report of [...history, ...currentReports]) {
    if (report) revisions.set(report.reportId, report)
  }
  return [...revisions.values()].sort(newestFirst)
}

const revisionLabel = (report: TaxReportModel, isCurrent: boolean) => {
  if (!isCurrent && String(report.pointerVersion) === '0') {
    return '이전 발행본'
  }
  return `revision ${String(report.pointerVersion)}`
}

const statusPriority = (status: TaxReportGenerationStatusModel) => {
  if (status.blockedReasonCode === 'APPLICATION_PENDING') return 0
  if (status.state === 'BUILDING') return 1
  if (status.state === 'FAILED') return 2
  if (
    status.state === 'REVIEW_REQUIRED' ||
    ['LEDGER_STALE', 'SOURCE_COVERAGE_INVALID', 'TAX_RESULT_STALE',
      'REVIEW_REQUIRED', 'GENERATION_INCOMPLETE', 'REPORT_NOT_CURRENT']
      .includes(status.blockedReasonCode ?? '')
  ) return 3
  if (status.outcome === 'NO_TAX_EVENTS') return 4
  return status.finality === 'FINAL' ? 5 : 6
}

const selectGenerationStatus = (
  statuses: TaxReportGenerationStatusModel[],
  current?: TaxReportModel | null,
) => {
  const currentStatus = current
    ? statuses.find((status) => status.finality === current.finality)
    : undefined
  return currentStatus ?? [...statuses].sort((left, right) =>
    statusPriority(left) - statusPriority(right))[0] ?? null
}

const canReadCurrent = (status: TaxReportGenerationStatusModel) =>
  (status.state === 'ACTIVE' || status.state === 'REVIEW_REQUIRED') &&
  status.outcome === 'REPORT' &&
  status.hasCurrentReport &&
  (status.blockedReasonCode === null ||
    status.blockedReasonCode === 'REVIEW_REQUIRED')

const blocksAllReportReads = (status: TaxReportGenerationStatusModel) =>
  status.blockedReasonCode === 'APPLICATION_PENDING' ||
  status.state === 'BUILDING' ||
  status.state === 'FAILED' ||
  (
    status.state === 'ACTIVE' &&
    status.outcome === 'NO_TAX_EVENTS' &&
    status.finality === 'FINAL'
  )

const generationPresentation = (
  status: TaxReportGenerationStatusModel,
  hasReadableCurrent: boolean,
) => {
  const hasAuthoritativeNoTaxEvents =
    status.state === 'ACTIVE' &&
    status.outcome === 'NO_TAX_EVENTS' &&
    status.finality === 'FINAL' &&
    status.coverageStatus === 'COMPLETE' &&
    status.sourceCoverageSummaryStatus === 'COMPLETE' &&
    status.coverageFrom === status.periodStart &&
    status.coverageThrough === status.periodEnd &&
    status.taxYearCloseStatus === 'CLOSED' &&
    ['DOCUMENT_METADATA_VERIFIED', 'CHAIN_VERIFIED'].includes(
      status.coverageAssurance,
    )

  if (status.blockedReasonCode === 'APPLICATION_PENDING') return {
    tone: 'pending', eyebrow: 'APPLICATION REQUIRED',
    title: '세무 장부 신청을 먼저 완료해 주세요',
    body: '신청이 완료되기 전에는 Tax Engine 계산 결과를 노출하지 않습니다.',
  }
  if (status.state === 'BUILDING') return {
    tone: 'building', eyebrow: 'BUILDING', title: '세무 장부를 생성하고 있습니다',
    body: '원장과 가격 근거를 묶어 연간 총평균 방식으로 다시 계산 중입니다.',
  }
  if (status.state === 'FAILED') return {
    tone: 'error', eyebrow: 'GENERATION FAILED', title: '장부 생성에 실패했습니다',
    body: status.failureCode
      ? `오류 코드 ${status.failureCode}를 기준으로 서버 작업 상태를 확인해 주세요.`
      : '계산 파이프라인 상태를 확인한 뒤 다시 생성해야 합니다.',
  }
  if (
    status.state === 'REVIEW_REQUIRED' &&
    canReadCurrent(status) &&
    hasReadableCurrent
  ) return {
    tone: 'review', eyebrow: 'REVIEW REQUIRED',
    title: '검토가 필요한 잠정 장부입니다',
    body: '현재 확보된 데이터로 계산한 추정 결과는 계속 확인할 수 있습니다. 누락 구간과 검토 항목을 보완한 뒤 전체 연도를 다시 계산해야 확정할 수 있습니다.',
  }
  if (hasAuthoritativeNoTaxEvents) return {
    tone: 'empty', eyebrow: 'NO TAX EVENTS',
    title: `${status.taxYear}년 과세 이벤트가 없습니다`,
    body: '전체 과세기간의 검증된 데이터에서 처분·대여소득 등 과세 계산 대상이 확인되지 않았습니다.',
  }
  if (
    status.state === 'REVIEW_REQUIRED' ||
    !['NOT_STARTED', 'GENERATION_NOT_ACTIVE'].includes(
      status.blockedReasonCode ?? '',
    )
  ) return {
    tone: 'review', eyebrow: 'REVIEW REQUIRED', title: '최신 장부를 다시 확인해야 합니다',
    body: '원장 변경, 데이터 범위 또는 계산 결과 정합성 문제로 읽을 수 있는 최신 장부가 없습니다. 검토를 마치고 다시 계산해 주세요.',
  }
  return {
    tone: 'empty', eyebrow: 'NOT STARTED', title: '아직 생성된 장부가 없습니다',
    body: '데이터가 연결되고 Tax Engine의 연간 계산이 시작되면 이곳에 상태와 결과가 표시됩니다.',
  }
}

const reportPageHeader = (status: TaxReportGenerationStatusModel | null) => {
  if (status?.blockedReasonCode === 'APPLICATION_PENDING') return {
    title: '세무 장부 신청',
    description: '데이터 소스를 확인하고 세무 장부 생성을 시작할 준비를 합니다.',
  }
  if (status?.state === 'BUILDING') return {
    title: '리포트 생성 중',
    description: 'Tax Engine의 실제 처리 상태를 확인합니다. 완료되면 결과 화면으로 자동 전환됩니다.',
  }
  if (status?.state === 'FAILED') return {
    title: '리포트 상태를 불러오지 못했습니다',
    description: '저장된 원본과 장부는 그대로입니다. 잠시 후 다시 확인해 주세요.',
  }
  if (
    status?.state === 'ACTIVE' &&
    status.outcome === 'NO_TAX_EVENTS' &&
    status.finality === 'FINAL'
  ) return {
    title: '과세 이벤트 없음',
    description: '전체 과세기간의 검증된 데이터에서 과세 계산 대상이 확인되지 않았습니다.',
  }
  if (status?.state === 'REVIEW_REQUIRED' && !canReadCurrent(status)) return {
    title: '재검토 필요',
    description: '최신 원장과 계산 결과의 정합성을 확인한 뒤 장부를 다시 생성해야 합니다.',
  }
  return {
    title: '세무 장부',
    description: 'Tax Engine이 발행한 계산 결과를 장부로 검토하고, 선택한 revision의 PDF를 생성합니다.',
  }
}

function ReportGenerationState({
  status,
  onRetry,
  hasReadableCurrent = false,
}: {
  status: TaxReportGenerationStatusModel
  onRetry: () => void
  hasReadableCurrent?: boolean
}) {
  const presentation = generationPresentation(status, hasReadableCurrent)
  const action = status.blockedReasonCode === 'APPLICATION_PENDING' ||
    ['NOT_STARTED', 'GENERATION_NOT_ACTIVE'].includes(
      status.blockedReasonCode ?? '',
    )
    ? { href: '/sources', label: '데이터 소스 확인' }
    : status.state === 'REVIEW_REQUIRED'
      ? { href: '/ledger', label: '장부 검토' }
      : null
  const standalone = !hasReadableCurrent

  if (standalone && presentation.tone === 'building') {
    const steps = [
      ['현재 상태', '생성 작업이 실행 중입니다', 'BUILDING'],
      ['안내', '다른 화면으로 이동해도 작업은 계속됩니다', '완료'],
      ['다음 표시', '리포트가 준비되면 계산 결과와 근거를 표시합니다', '숨김'],
      ['표시 제한', 'PDF와 블록체인 증명은 준비된 리포트에서만 사용할 수 있습니다', '대기'],
      ['자동 새로고침', '상태가 바뀌면 이 화면은 최신 결과로 교체합니다', '자동'],
    ]
    return (
      <section
        className="report-generation-state report-generation-state--building"
        data-standalone="true"
        data-tone={presentation.tone}
      >
        <header>
          <span>생성 중 · 잠정</span>
          <h3>실제 처리 상태만 표시합니다</h3>
          <p>리포트가 준비되면 세액과 PDF, 블록체인 증명을 보여 드립니다.</p>
        </header>
        <div className="report-generation-state__steps">
          {steps.map(([label, detail, value], index) => (
            <div data-active={index < 2 ? 'true' : undefined} key={label}>
              <span><strong>{label}</strong><small>{detail}</small></span>
              <em>{value}</em>
            </div>
          ))}
        </div>
        <a href="/sources">데이터 범위 보기 →</a>
        <small className="report-generation-state__polling" role="status">
          상태를 자동으로 다시 확인하고 있습니다.
        </small>
      </section>
    )
  }

  if (standalone && presentation.tone === 'error') {
    return (
      <section
        className="report-generation-state report-generation-state--error"
        data-standalone="true"
        data-tone={presentation.tone}
      >
        <div className="report-generation-state__error-icon" aria-hidden="true">!</div>
        <header>
          <h3>일시적인 조회 오류가 발생했습니다</h3>
          <p>리포트 상태나 결과를 불러오지 못했습니다.</p>
        </header>
        <div className="report-generation-state__error-detail">
          <strong>오류 범위 · 리포트 조회</strong>
          <span>현재 상태를 다시 확인한 뒤, 리포트가 활성화된 경우에만 결과를 표시합니다.</span>
          <small>{status.failureCode ? `오류 번호 · ${status.failureCode}` : '오류 번호 · 문의 시 함께 전달'}</small>
        </div>
        <div className="report-generation-state__actions">
          <button type="button" onClick={onRetry}>상태 다시 확인</button>
          <a href="/sources">데이터 범위 보기</a>
        </div>
        <small>계속 실패하면 오류 번호와 함께 문의해 주세요.</small>
      </section>
    )
  }

  if (standalone && presentation.tone === 'empty' && status.outcome === 'NO_TAX_EVENTS') {
    return (
      <section
        className="report-generation-state report-generation-state--no-events"
        data-standalone="true"
        data-tone={presentation.tone}
      >
        <div className="report-generation-state__empty-icon" aria-hidden="true">＋</div>
        <header>
          <h3>계산은 완료되었지만 과세 이벤트가 없습니다</h3>
          <p>데이터 범위와 거래 분류를 확인할 수 있습니다.</p>
        </header>
        <div className="report-generation-state__actions">
          <a href="/sources">데이터 범위 보기</a>
          <a href="/ledger">거래 검토 보기</a>
        </div>
        <dl>
          <div><dt>완료 상태</dt><dd>{status.finality} · 과세 이벤트 없음</dd></div>
          <div><dt>사용 가능 항목</dt><dd>데이터 범위 · 거래 검토</dd></div>
        </dl>
      </section>
    )
  }

  return (
    <section
      className="report-generation-state"
      data-standalone={standalone ? 'true' : undefined}
      data-tone={presentation.tone}
    >
      <div className="report-generation-state__icon" aria-hidden="true" />
      <div>
        <span>{presentation.eyebrow}</span>
        <h3>{presentation.title}</h3>
        <p>{presentation.body}</p>
      </div>
      <dl>
        <div><dt>대상 연도</dt><dd>{status.taxYear}</dd></div>
        <div><dt>계산 구분</dt><dd>{status.finality}</dd></div>
        <div><dt>상태 코드</dt><dd>{status.blockedReasonCode ?? status.state}</dd></div>
      </dl>
      {status.state === 'BUILDING' ? (
        <small className="report-generation-state__polling" role="status">
          상태를 자동으로 다시 확인하고 있습니다.
        </small>
      ) : null}
      {status.state === 'FAILED' ? (
        <button type="button" onClick={onRetry}>상태 다시 확인</button>
      ) : action ? (
        <a href={action.href}>{action.label}</a>
      ) : null}
    </section>
  )
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
  const [generationStatus, setGenerationStatus] =
    useState<TaxReportGenerationStatusModel | null>(null)
  const [reportDetail, setReportDetail] =
    useState<AnyTaxReportDetailModel | null>(null)
  const [detailStatus, setDetailStatus] =
    useState<'error' | 'idle' | 'loading' | 'not-found' | 'ready'>('idle')
  const [statusRequestVersion, setStatusRequestVersion] = useState(0)
  const buildingPollCount = useRef(0)

  useEffect(() => {
    const controller = new AbortController()

    setCurrentReport(null)
    setRevisions([])
    setSelectedReportId(undefined)
    setReportDetail(null)
    setGenerationStatus(null)
    setDetailStatus('idle')

    if (Number(year) < 2025) {
      setTaxStatus('unsupported')
      return () => controller.abort()
    }

    setTaxStatus('loading')
    void Promise.allSettled([
      loadTaxReportGenerationStatus(year, 'FINAL', controller.signal),
      loadTaxReportGenerationStatus(year, 'PROVISIONAL', controller.signal),
    ])
      .then(async (statusResults) => {
        if (controller.signal.aborted) return
        const statuses = statusResults
          .filter((result): result is PromiseFulfilledResult<{
            status: TaxReportGenerationStatusModel
          }> => result.status === 'fulfilled')
          .map((result) => result.value.status)
        const rejectedStatus = statusResults.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        )
        if (rejectedStatus) {
          throw rejectedStatus.reason ?? new Error('tax report status unavailable')
        }

        const blockingStatus = [...statuses]
          .sort((left, right) => statusPriority(left) - statusPriority(right))
          .find(blocksAllReportReads)
        const readableStatuses = blockingStatus
          ? []
          : statuses.filter(canReadCurrent)
        const canReadReportData = readableStatuses.length > 0
        const currentResults = await Promise.allSettled(
          readableStatuses.map((status) =>
            loadCurrentTaxReport(year, status.finality, controller.signal),
          ),
        )
        if (controller.signal.aborted) return
        const availableCurrents = currentResults
          .filter((result): result is PromiseFulfilledResult<{ report: TaxReportModel }> =>
            result.status === 'fulfilled')
          .map((result) => result.value.report)
        const latestCurrent = availableCurrents.sort(newestFirst)[0] ?? null
        const historyResult = canReadReportData && latestCurrent
          ? await loadTaxReportHistory(year, controller.signal)
              .then((value) => ({ status: 'fulfilled' as const, value }))
              .catch((reason: unknown) => ({ status: 'rejected' as const, reason }))
          : {
              status: 'fulfilled' as const,
              value: { items: [] as TaxReportModel[] },
            }
        if (controller.signal.aborted) return
        const history = historyResult.status === 'fulfilled'
          ? historyResult.value.items
          : []
        const availableRevisions = mergeRevisions(
          history,
          ...availableCurrents,
        )
        const rejectedCurrent = currentResults.find(
          (result) => result.status === 'rejected',
        )
        if (
          !latestCurrent &&
          rejectedCurrent &&
          readableStatuses.some((status) => status.state !== 'REVIEW_REQUIRED')
        ) {
          throw rejectedCurrent.reason
        }

        setCurrentReport(latestCurrent)
        setGenerationStatus(
          blockingStatus ?? selectGenerationStatus(statuses, latestCurrent),
        )
        setRevisions(availableRevisions)
        setSelectedReportId(
          latestCurrent?.reportId ?? availableRevisions[0]?.reportId,
        )
        setTaxStatus('ready')

        const building = statuses.some((status) => status.state === 'BUILDING')
        if (building && buildingPollCount.current < 12) {
          buildingPollCount.current += 1
          window.setTimeout(() => {
            if (!controller.signal.aborted) {
              setStatusRequestVersion((value) => value + 1)
            }
          }, 5_000)
        } else if (!building) {
          buildingPollCount.current = 0
        }
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) {
          setTaxStatus('error')
        }
      })

    return () => controller.abort()
  }, [statusRequestVersion, year])

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
        if (controller.signal.aborted) return
        setReportDetail(result.report)
        setDetailStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
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
    buildingPollCount.current = 0
    setYear(nextYear)
    saveAppYear(nextYear)
  }

  const pageHeader = reportPageHeader(generationStatus)
  const showsV2Detail =
    detailStatus === 'ready' &&
    reportDetail?.schemaVersion === 'giwa.tax-report-model.v2'
  const v2RevisionControl = revisions.length > 0 ? (
    <section
      className="tax-report-v2__revision-control"
      aria-labelledby="tax-report-v2-revision-title"
    >
      <h3 className="sr-only" id="tax-report-v2-revision-title">
        장부 revision
      </h3>
      <label>
        <span className="sr-only">발행본 전환</span>
        <select
          aria-label="장부 revision 선택"
          value={selectedReportId}
          onChange={(event) => setSelectedReportId(event.target.value)}
        >
          {revisions.map((report) => {
            const isCurrent = report.reportId === currentReport?.reportId
            return (
              <option key={report.reportId} value={report.reportId}>
                {revisionLabel(report, isCurrent)}{isCurrent ? ' · 현재' : ''}
              </option>
            )
          })}
        </select>
      </label>
    </section>
  ) : null

  return (
    <div className="ledger-page report-page product-shell">
      <AppSidebar
        activePage="reports"
        year={year}
        onYearChange={handleYearChange}
      />
      <main className="report-main">
        {!showsV2Detail ? (
          <PageHeader
            description={pageHeader.description}
            eyebrow="TAX LEDGER"
            title={pageHeader.title}
            tone="workspace"
          />
        ) : null}

        <section
          className="tax-report-section"
          aria-labelledby="tax-report-section-title"
        >
          <h2 className="sr-only" id="tax-report-section-title">
            {year}년 가상자산 세무 장부
          </h2>
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
            generationStatus ? (
              <ReportGenerationState
                status={generationStatus}
                onRetry={() => setStatusRequestVersion((value) => value + 1)}
              />
            ) : null
          ) : null}

          {taxStatus === 'ready' && generationStatus &&
          (generationStatus.state === 'REVIEW_REQUIRED' ||
            !canReadCurrent(generationStatus)) && revisions.length > 0 ? (
            <ReportGenerationState
              status={generationStatus}
              onRetry={() => setStatusRequestVersion((value) => value + 1)}
              hasReadableCurrent={Boolean(currentReport)}
            />
          ) : null}

          {!showsV2Detail && currentReport && generationStatus && canReadCurrent(generationStatus) &&
          generationStatus.coverageStatus !== 'COMPLETE' ? (
            <aside className="report-coverage-notice" role="note">
              <strong>전체 연도 중 현재 확보된 데이터까지만 반영했습니다.</strong>
              <span>
                {generationStatus.periodStart} ~ {generationStatus.periodEnd} 중{' '}
                {generationStatus.coverageFrom ?? '범위 미확인'} ~{' '}
                {generationStatus.coverageThrough ?? '범위 미확인'} 계산
              </span>
            </aside>
          ) : null}

          {revisions.length > 0 && !showsV2Detail ? (
            <section className="tax-report-revisions" aria-labelledby="tax-report-revisions-title">
              <h3 id="tax-report-revisions-title">장부 revision</h3>
              <div>
                <span>{selectedReportId === currentReport?.reportId ? '현재 장부' : '이전 발행본'}</span>
                <strong>
                  {selectedReport
                    ? revisionLabel(
                        selectedReport,
                        selectedReport.reportId === currentReport?.reportId,
                      )
                    : '발행본 선택'}
                  {selectedReport?.reportId === currentReport?.reportId
                    ? <em>현재</em>
                    : null}
                </strong>
              </div>
              <label>
                <span>발행본 전환</span>
                <select
                  aria-label="장부 revision 선택"
                  value={selectedReportId}
                  onChange={(event) => setSelectedReportId(event.target.value)}
                >
                  {revisions.map((report) => {
                    const isCurrent = report.reportId === currentReport?.reportId
                    return (
                      <option key={report.reportId} value={report.reportId}>
                        {revisionLabel(report, isCurrent)}{isCurrent ? ' · 현재' : ''} · {new Date(report.issuedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}
                      </option>
                    )
                  })}
                </select>
              </label>
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
            reportDetail.schemaVersion === 'giwa.tax-report-model.v2' ? (
              <TaxReportDetailV2
                key={reportDetail.reportId}
                report={reportDetail}
                pointerVersion={
                  selectedReport && String(selectedReport.pointerVersion) !== '0'
                    ? selectedReport.pointerVersion
                    : undefined
                }
                isCurrent={selectedReportId === currentReport?.reportId}
                filingStatus={selectedReport?.filingStatus}
                revisionControl={v2RevisionControl}
                generationState={
                  selectedReportId === currentReport?.reportId &&
                  (generationStatus?.state === 'ACTIVE' ||
                    generationStatus?.state === 'REVIEW_REQUIRED')
                    ? generationStatus.state
                    : undefined
                }
              />
            ) : (
              <TaxReportDetail
                key={reportDetail.reportId}
                report={reportDetail}
                pointerVersion={
                  selectedReport &&
                  (selectedReport.reportId === currentReport?.reportId ||
                    String(selectedReport.pointerVersion) !== '0')
                    ? selectedReport.pointerVersion
                    : undefined
                }
                isCurrent={selectedReportId === currentReport?.reportId}
              />
            )
          ) : null}
        </section>
      </main>
    </div>
  )
}
