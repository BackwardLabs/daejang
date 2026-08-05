import { Fragment, useEffect, useState } from 'react'
import { ApiClientError } from '../../api/client.ts'
import {
  loadTaxReportEvidence,
  type TaxAmountModel,
  type TaxEvidenceCoordinateModel,
  type TaxEvidencePackModel,
  type TaxReportCalculationRuleModel,
  type TaxReportDetailModel,
  type TaxReportModel,
  type TaxReportRateModel,
} from './taxReportApi.ts'
import { formatLedgerQuantity } from '../ledger/ledgerPresentation.ts'

type ReportTab =
  | 'summary'
  | 'disposals'
  | 'movements'
  | 'limitations'
  | 'trace'

const tabs: Array<{ id: ReportTab; label: string }> = [
  { id: 'summary', label: '요약' },
  { id: 'disposals', label: '처분 장부' },
  { id: 'movements', label: '이체·전환' },
  { id: 'limitations', label: '검토 항목' },
  { id: 'trace', label: '계산 근거' },
]

const evidenceCoordinateFields: Array<{
  key: Exclude<keyof TaxEvidenceCoordinateModel, 'kind'>
  label: string
}> = [
  { key: 'eventId', label: 'Event' },
  { key: 'revisionId', label: 'Ledger revision' },
  { key: 'legId', label: 'Leg' },
  { key: 'relationId', label: 'Relation' },
  { key: 'valuationId', label: 'Valuation' },
  { key: 'movementId', label: 'Movement' },
  { key: 'reviewId', label: 'Review' },
  { key: 'reviewRevisionId', label: 'Review revision' },
  { key: 'fragmentId', label: 'Fragment' },
  { key: 'observationId', label: 'Observation' },
  { key: 'generationId', label: 'Generation' },
  { key: 'schemaDigest', label: 'Schema digest' },
]

const reportDenominations: Record<
  string,
  { symbol: string; decimals: number }
> = {
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}
const costMethodLabel = (value: string) => {
  const labels: Record<string, string> = {
    FIFO: '선입선출법',
    LIFO: '후입선출법',
    MOVING_AVERAGE: '이동평균법',
    SPECIFIC_IDENTIFICATION: '개별법',
    WEIGHTED_AVERAGE: '총평균법',
    ANNUAL_TOTAL_AVERAGE: '연간 총평균법',
  }
  return labels[value] ?? value
}

const poolScopeLabel = (value: string) => {
  const labels: Record<string, string> = {
    ADDRESS: '주소별',
    RESIDENT_TAX_YEAR_TAX_ASSET: '거주자 × 과세연도 × 세무자산',
  }
  return labels[value] ?? value
}

const roundingLabel = (value: string) => {
  if (!value) return '기록 없음'
  const labels: Record<string, string> = {
    CUMULATIVE_FLOOR_ANNUAL_POOL: '연간 묶음의 누적 배분값을 기준으로 버림',
    FLOOR: '버림',
    FLOOR_EXCEPT_EXHAUSTED_LAYER: '소진된 원가 묶음을 제외하고 버림',
    MIXED: '여러 반올림 규칙 혼합',
  }
  return labels[value] ?? value
}

const finalityPresentation: Record<
  TaxReportDetailModel['finality'],
  { description: string; label: string }
> = {
  FINAL: {
    label: 'FINAL · 평가 입력 확정',
    description:
      'Tax Engine이 사용한 가격·평가 입력이 확정 상태라는 뜻입니다. 연간 데이터 마감 완료를 뜻하지 않습니다.',
  },
  PROVISIONAL: {
    label: 'PROVISIONAL · 평가 입력 잠정',
    description:
      '가격·평가 입력이 잠정 상태이므로 이후 근거가 바뀌면 계산도 달라질 수 있습니다.',
  },
}

const taxYearClosePresentation: Record<
  TaxReportDetailModel['taxYearCloseStatus'],
  { description: string; label: string }
> = {
  CLOSED: {
    label: '연간 마감 확인됨',
    description: '해당 과세연도의 전체 입력 마감과 최종 재계산이 기록됐습니다.',
  },
  UNVERIFIED: {
    label: '연간 마감 미확인',
    description:
      '현재 ReportModel V1에는 연간 입력 마감과 최종 전체 재계산을 증명하는 필드가 없습니다.',
  },
}

const resultStatusPresentation: Record<
  TaxReportDetailModel['status'],
  { description: string; label: string }
> = {
  FINAL: {
    label: '전체 확정',
    description: '현재 입력 범위에서 모든 계산 금액이 확정되었습니다.',
  },
  PARTIAL: {
    label: '일부 미확정',
    description: '확정할 수 없는 금액이나 검토 항목이 남아 있습니다.',
  },
}

const filingStatusPresentation: Record<
  TaxReportDetailModel['filingStatus'],
  { description: string; label: string }
> = {
  READY: {
    label: '엔진 판정: 신고 준비 조건 충족',
    description:
      'Tax Engine이 현재 입력에 차단 항목이 없다고 판정했습니다. 원화 단위와 최종 신고 적합성을 별도로 검토해야 합니다.',
  },
  BLOCKED: {
    label: '검토 필요',
    description: '미확정 값이나 보완 항목을 먼저 확인해야 합니다.',
  },
}

const calculationContractPresentation: Record<
  TaxReportDetailModel['summary']['calculationContract'],
  { description: string; label: string; tone: 'ready' | 'warning' }
> = {
  ANNUAL_TOTAL_AVERAGE: {
    label: '연간 총평균 원가 계약 기록됨',
    description:
      '이 발행본에 원가 방식과 계산 묶음 규칙이 기록되어 있다는 뜻입니다. 원화 단위, 세액 또는 신고 적합성까지 검증됐다는 뜻은 아닙니다.',
    tone: 'ready',
  },
  LEGACY: {
    label: '주소별 이동평균/FIFO 과거 계산본',
    description:
      '이 발행본은 연간 총평균 전환 전 계산 계약을 사용합니다. 총평균법 기준 신고 자료로 해석하면 안 됩니다.',
    tone: 'warning',
  },
  UNSUPPORTED: {
    label: '이 발행본만으로 계산 계약 확인 불가',
    description:
      '계산 규칙 메타데이터가 없거나 현재 지원 계약과 일치하지 않아 총평균법 적용 여부를 확인할 수 없습니다.',
    tone: 'warning',
  },
}

function decimal(value: string) {
  const [integer = '', fraction] = value.split('.', 2)
  const sign = integer.startsWith('-') ? '-' : ''
  const digits = sign ? integer.slice(1) : integer
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

function amountLabel(amount: TaxAmountModel, denomination: string) {
  if (
    !amount.hasAmount ||
    amount.amount === null ||
    amount.amount === undefined
  ) {
    return '미확정'
  }
  const presentation = reportDenominations[denomination]
  if (presentation) {
    return `${formatLedgerQuantity(
      amount.amount,
      presentation.decimals,
    )} ${presentation.symbol}`
  }
  return `${decimal(amount.amount)} ${denomination}`
}

function canonicalAmountLabel(
  amount: string | null | undefined,
  denomination: string,
) {
  if (!amount) return '미확정'
  return amountLabel(
    { amount, hasAmount: true, status: 'KNOWN' },
    denomination,
  )
}

function rateLabel(rate: TaxReportRateModel) {
  const numerator = Number(rate.numerator)
  const denominator = Number(rate.denominator)
  const ratio = `${decimal(rate.numerator)} / ${decimal(rate.denominator)}`
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return ratio
  }
  const percentage = new Intl.NumberFormat('ko-KR', {
    maximumFractionDigits: 6,
  }).format((numerator / denominator) * 100)
  return `${percentage}% (${ratio})`
}

function calculationMethodLabel(rule: TaxReportCalculationRuleModel) {
  if (rule.costMethods.length === 0) return '미확정'
  return rule.costMethods.map(costMethodLabel).join(', ')
}

function isUnknown(amount: TaxAmountModel) {
  return (
    !amount.hasAmount ||
    amount.amount === null ||
    amount.amount === undefined
  )
}

function hasUnknownAmounts(report: TaxReportDetailModel) {
  return [
    report.summary.gainLoss,
    report.summary.taxableBase,
    report.summary.nationalTax,
    report.summary.localTax,
    report.summary.totalTax,
    ...Object.values(report.totals),
    ...report.assetSummaries.flatMap((asset) => [
      asset.grossProceeds,
      asset.acquisitionCost,
      asset.ancillaryExpense,
      asset.gainLoss,
    ]),
    ...report.disposals.flatMap((disposal) => [
      disposal.grossProceeds,
      disposal.basis,
      disposal.ancillaryExpense,
      disposal.gainLoss,
    ]),
    ...report.transfers.map((transfer) => transfer.basis),
  ].some(isUnknown)
}

function AmountValue({
  amount,
  denomination,
}: {
  amount: TaxAmountModel
  denomination: string
}) {
  const unknown =
    !amount.hasAmount ||
    amount.amount === null ||
    amount.amount === undefined

  return (
    <span
      className="tax-report-detail__amount"
      data-certainty={unknown ? 'UNKNOWN' : 'KNOWN'}
    >
      {amountLabel(amount, denomination)}
    </span>
  )
}

function EmptyRows({ children }: { children: string }) {
  return <p className="tax-report-detail__empty">{children}</p>
}

export function TaxReportDetail({
  report,
  pointerVersion,
  isCurrent = false,
}: {
  report: TaxReportDetailModel
  pointerVersion?: TaxReportModel['pointerVersion']
  isCurrent?: boolean
}) {
  const [activeTab, setActiveTab] = useState<ReportTab>('summary')
  const [expandedAssetIds, setExpandedAssetIds] = useState<Set<string>>(
    () => new Set(),
  )
  const [evidencePack, setEvidencePack] =
    useState<TaxEvidencePackModel | null>(null)
  const [evidenceStatus, setEvidenceStatus] =
    useState<'error' | 'idle' | 'loading' | 'not-found' | 'ready'>('idle')
  const pdfHref =
    `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`
  const evidenceHref =
    `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/evidence`
  const unknownAmounts = hasUnknownAmounts(report)
  const isFilingReady =
    report.taxYear >= 2027 &&
    report.taxYearCloseStatus === 'CLOSED' &&
    report.finality === 'FINAL' &&
    report.status === 'FINAL' &&
    report.filingStatus === 'READY' &&
    report.summary.calculationContract === 'ANNUAL_TOTAL_AVERAGE' &&
    report.summary.calculationRule?.deductionUsedAmount != null &&
    report.counts.limitations === 0 &&
    report.limitations.length === 0 &&
    !unknownAmounts
  const finality = finalityPresentation[report.finality]
  const taxYearClose = taxYearClosePresentation[report.taxYearCloseStatus]
  const resultStatus = resultStatusPresentation[report.status]
  const filingStatus = filingStatusPresentation[report.filingStatus]
  const calculationContract =
    calculationContractPresentation[report.summary.calculationContract]
  const evidenceKindCounts =
    activeTab === 'trace'
      ? evidencePack?.evidenceCoordinates.reduce<Record<string, number>>(
          (counts, coordinate) => {
            counts[coordinate.kind] = (counts[coordinate.kind] ?? 0) + 1
            return counts
          },
          {},
        )
      : undefined
  const evidenceCoordinatesPreview =
    evidencePack?.evidenceCoordinates.slice(0, 12) ?? []
  const artifactRootsPreview = evidencePack?.artifactRoots.slice(0, 20) ?? []

  useEffect(() => {
    setActiveTab('summary')
    setExpandedAssetIds(new Set())
    setEvidencePack(null)
    setEvidenceStatus('idle')
  }, [report.reportId])

  useEffect(() => {
    if (
      activeTab !== 'trace' ||
      evidencePack?.reportId === report.reportId
    ) {
      return
    }
    const controller = new AbortController()
    setEvidenceStatus('loading')
    void loadTaxReportEvidence(report.reportId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setEvidencePack(result.evidencePack)
        setEvidenceStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return
        }
        setEvidencePack(null)
        setEvidenceStatus(
          error instanceof ApiClientError && error.status === 404
            ? 'not-found'
            : 'error',
        )
      })
    return () => controller.abort()
  }, [activeTab, evidencePack?.reportId, report.reportId])

  const toggleAsset = (taxAssetId: string) => {
    setExpandedAssetIds((current) => {
      const next = new Set(current)
      if (next.has(taxAssetId)) next.delete(taxAssetId)
      else next.add(taxAssetId)
      return next
    })
  }

  return (
    <article
      className="tax-report-detail"
      aria-labelledby="tax-report-detail-title"
    >
      <header className="tax-report-detail__header">
        <div>
          <span>ISSUED TAX LEDGER</span>
          <h2 id="tax-report-detail-title">
            {report.taxYear}년 가상자산 세무 장부
          </h2>
          <p>
            {pointerVersion === undefined
              ? '발행본'
              : `revision ${String(pointerVersion)}`}
            {isCurrent ? ' · 현재 장부' : ' · 이전 발행본'} ·{' '}
            {new Date(report.issuedAt).toLocaleString('ko-KR')} 발행
          </p>
        </div>
        <div className="tax-report-detail__header-actions">
          <a href={pdfHref} download>
            {isFilingReady ? '신고 준비 자료 PDF' : '검토용 PDF'}
          </a>
        </div>
      </header>

      <section
        className="tax-report-detail__status-board"
        aria-labelledby="tax-report-status-title"
      >
        <header>
          <div>
            <span>REPORT STATUS</span>
            <h3 id="tax-report-status-title">현재 장부 상태</h3>
          </div>
          <p>평가 입력, 연간 마감, 계산 완전성, 신고 준비 상태를 각각 구분합니다.</p>
        </header>
        <dl>
          <div>
            <dt>평가 입력 상태</dt>
            <dd>
              <b data-status={report.finality}>{finality.label}</b>
              <small>{finality.description}</small>
            </dd>
          </div>
          <div>
            <dt>연간 마감 상태</dt>
            <dd>
              <b data-status={report.taxYearCloseStatus}>
                {taxYearClose.label}
              </b>
              <small>{taxYearClose.description}</small>
            </dd>
          </div>
          <div>
            <dt>계산 결과 상태</dt>
            <dd>
              <b data-status={report.status}>{resultStatus.label}</b>
              <small>{resultStatus.description}</small>
            </dd>
          </div>
          <div>
            <dt>신고 준비 상태</dt>
            <dd>
              <b data-status={report.filingStatus}>{filingStatus.label}</b>
              <small>{filingStatus.description}</small>
            </dd>
          </div>
        </dl>
      </section>

      {unknownAmounts ? (
        <aside className="tax-report-detail__warning" role="note">
          <strong>‘미확정’은 0원을 뜻하지 않습니다.</strong>
          <p>
            취득원가나 원천 데이터가 보완되면 해당 금액과 예상 세액이
            달라질 수 있습니다. 아래 검토 항목에서 원인을 확인해 주세요.
          </p>
        </aside>
      ) : null}

      <div className="tax-report-detail__tabs" role="tablist" aria-label="장부 내용">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            id={`tax-report-tab-${tab.id}`}
            role="tab"
            aria-controls={`tax-report-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'limitations' && report.limitations.length > 0 ? (
              <span>{report.limitations.length.toLocaleString('ko-KR')}</span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === 'summary' ? (
        <div
          id="tax-report-panel-summary"
          role="tabpanel"
          aria-labelledby="tax-report-tab-summary"
          className="tax-report-detail__panel"
        >
          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-ledger-summary-title"
          >
            <header>
              <div>
                <span>LEDGER TOTALS</span>
                <h3 id="tax-report-ledger-summary-title">장부 계산 요약</h3>
              </div>
              <p>표시 통화 {report.denominationAssetId}</p>
            </header>
            <dl className="tax-report-detail__summary is-ledger-total">
              {[
                ['총 처분가액', report.totals.grossProceeds],
                ['총 취득원가', report.totals.acquisitionCost],
                ['총 필요경비', report.totals.ancillaryExpense],
                ['총 양도 손익', report.totals.gainLoss],
              ].map(([label, amount]) => (
                <div key={label as string}>
                  <dt>{label as string}</dt>
                  <dd>
                    <AmountValue
                      amount={amount as TaxAmountModel}
                      denomination={report.denominationAssetId}
                    />
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-tax-summary-title"
          >
            <header>
              <div>
                <span>TAX ESTIMATE</span>
                <h3 id="tax-report-tax-summary-title">세금 추정 요약</h3>
              </div>
            </header>
            <dl className="tax-report-detail__summary">
              {[
                ['양도 손익', report.summary.gainLoss],
                ['과세표준', report.summary.taxableBase],
                ['국세', report.summary.nationalTax],
                ['지방세', report.summary.localTax],
                ['예상 총 세액', report.summary.totalTax],
              ].map(([label, amount]) => (
                <div key={label as string}>
                  <dt>{label as string}</dt>
                  <dd>
                    <AmountValue
                      amount={amount as TaxAmountModel}
                      denomination={report.denominationAssetId}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <dl className="tax-report-detail__counts" aria-label="장부 항목 수">
              <div>
                <dt>처분</dt>
                <dd>{report.counts.disposals.toLocaleString('ko-KR')}건</dd>
              </div>
              <div>
                <dt>이체</dt>
                <dd>{report.counts.transfers.toLocaleString('ko-KR')}건</dd>
              </div>
              <div>
                <dt>제외 전환</dt>
                <dd>
                  {report.counts.excludedConversions.toLocaleString('ko-KR')}건
                </dd>
              </div>
              <div>
                <dt>검토 항목</dt>
                <dd>{report.counts.limitations.toLocaleString('ko-KR')}건</dd>
              </div>
            </dl>
          </section>

          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-calculation-rule-title"
          >
            <header>
              <div>
                <span>CALCULATION RULE</span>
                <h3 id="tax-report-calculation-rule-title">적용 계산 기준</h3>
              </div>
              <p>Tax Engine이 이 발행본에 기록한 계산 규칙입니다.</p>
            </header>
            <aside
              className={
                calculationContract.tone === 'ready'
                  ? 'tax-report-detail__ready'
                  : 'tax-report-detail__warning'
              }
              data-calculation-contract={report.summary.calculationContract}
              role="note"
            >
              <strong>{calculationContract.label}</strong>
              <p>{calculationContract.description}</p>
            </aside>
            {report.summary.calculationRule ? (
              <dl className="tax-report-detail__calculation-rule">
                <div>
                  <dt>원가 계산 방식</dt>
                  <dd>
                    <strong>
                      {calculationMethodLabel(report.summary.calculationRule)}
                    </strong>
                    <small>
                      {report.summary.calculationRule.costMethods.join(', ') ||
                        '기록 없음'}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>계산 묶음</dt>
                  <dd>
                    <strong>
                      {poolScopeLabel(report.summary.calculationRule.poolScope)}
                    </strong>
                    <small>{report.summary.calculationRule.poolScope}</small>
                  </dd>
                </div>
                <div>
                  <dt>Tax Engine 기본공제 값</dt>
                  <dd>
                    <strong>
                      {canonicalAmountLabel(
                        report.summary.calculationRule.basicDeductionAmount,
                        report.denominationAssetId,
                      )}
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt>Tax Engine 사용 공제 값</dt>
                  <dd>
                    <strong
                      data-certainty={
                        report.summary.calculationRule.deductionUsedAmount
                          ? 'KNOWN'
                          : 'UNKNOWN'
                      }
                    >
                      {canonicalAmountLabel(
                        report.summary.calculationRule.deductionUsedAmount,
                        report.denominationAssetId,
                      )}
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt>국세율</dt>
                  <dd>
                    <strong>
                      {rateLabel(report.summary.calculationRule.nationalRate)}
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt>지방세율</dt>
                  <dd>
                    <strong>
                      {rateLabel(report.summary.calculationRule.localRate)}
                    </strong>
                  </dd>
                </div>
                <div>
                  <dt>세액 반올림</dt>
                  <dd>
                    <strong>
                      {roundingLabel(report.summary.calculationRule.taxRounding)}
                    </strong>
                    <small>{report.summary.calculationRule.taxRounding}</small>
                  </dd>
                </div>
                <div>
                  <dt>취득원가 배분 반올림</dt>
                  <dd>
                    <strong>
                      {roundingLabel(
                        report.summary.calculationRule
                          .basisAllocationRounding,
                      )}
                    </strong>
                    <small>
                      {report.summary.calculationRule
                        .basisAllocationRounding || '기록 없음'}
                    </small>
                  </dd>
                </div>
              </dl>
            ) : null}
            {report.summary.calculationRule ? (
              <p className="tax-report-detail__calculation-unit-note">
                공제액과 세액은 ReportModel의 표시 통화 단위를 프런트에서
                임의 보정하지 않고 그대로 표시합니다.
              </p>
            ) : null}
          </section>

          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-assets-title"
          >
            <header>
              <div>
                <span>BY ASSET</span>
                <h3 id="tax-report-assets-title">자산별 계산 요약</h3>
              </div>
              <p>{report.assetSummaries.length.toLocaleString('ko-KR')}개 자산</p>
            </header>
            {report.assetSummaries.length === 0 ? (
              <EmptyRows>요약할 처분 자산이 없습니다.</EmptyRows>
            ) : (
              <div className="tax-report-detail__table-scroll is-asset-summary">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">자산</th>
                      <th scope="col">처분 건수</th>
                      <th scope="col">처분 수량(최소 단위)</th>
                      <th scope="col">처분가액</th>
                      <th scope="col">취득원가</th>
                      <th scope="col">필요경비</th>
                      <th scope="col">양도 손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.assetSummaries.map((asset, index) => {
                      const isExpanded = expandedAssetIds.has(
                        asset.taxAssetId,
                      )
                      const assetDisposals = report.disposals.filter(
                        (disposal) =>
                          disposal.taxAssetId === asset.taxAssetId,
                      )
                      const detailsId = `tax-report-asset-disposals-${index}`
                      return (
                        <Fragment key={asset.taxAssetId}>
                          <tr>
                            <th scope="row">
                              <button
                                type="button"
                                className="tax-report-detail__asset-toggle"
                                aria-controls={detailsId}
                                aria-expanded={isExpanded}
                                aria-label={`${asset.taxAssetId} 처분 내역 ${
                                  isExpanded ? '접기' : '펼쳐보기'
                                }`}
                                onClick={() => toggleAsset(asset.taxAssetId)}
                              >
                                <strong>{asset.taxAssetId}</strong>
                                <small>
                                  {isExpanded
                                    ? '처분 내역 접기'
                                    : '처분 내역 펼쳐보기'}
                                </small>
                              </button>
                            </th>
                            <td className="is-numeric">
                              {asset.disposalCount.toLocaleString('ko-KR')}건
                            </td>
                            <td className="is-numeric">
                              {decimal(asset.quantity)}
                            </td>
                            <td className="is-numeric">
                              <AmountValue
                                amount={asset.grossProceeds}
                                denomination={report.denominationAssetId}
                              />
                            </td>
                            <td className="is-numeric">
                              <AmountValue
                                amount={asset.acquisitionCost}
                                denomination={report.denominationAssetId}
                              />
                            </td>
                            <td className="is-numeric">
                              <AmountValue
                                amount={asset.ancillaryExpense}
                                denomination={report.denominationAssetId}
                              />
                            </td>
                            <td className="is-numeric">
                              <AmountValue
                                amount={asset.gainLoss}
                                denomination={report.denominationAssetId}
                              />
                            </td>
                          </tr>
                          {isExpanded ? (
                            <tr className="tax-report-detail__asset-detail-row">
                              <td colSpan={7} id={detailsId}>
                                <div className="tax-report-detail__asset-disposals">
                                  <header>
                                    <div>
                                      <strong>
                                        {asset.taxAssetId} 개별 처분 내역
                                      </strong>
                                      <p>
                                        Tax Engine이 발행한 처분 행을 자산별로
                                        모아 표시하며, 화면에서 금액을 다시
                                        계산하지 않습니다.
                                      </p>
                                    </div>
                                    <span>
                                      {assetDisposals.length.toLocaleString(
                                        'ko-KR',
                                      )}
                                      건
                                    </span>
                                  </header>
                                  {assetDisposals.length === 0 ? (
                                    <EmptyRows>
                                      연결된 개별 처분 행이 없습니다.
                                    </EmptyRows>
                                  ) : (
                                    <div className="tax-report-detail__asset-disposals-table">
                                      <table>
                                        <thead>
                                          <tr>
                                            <th scope="col">처분 ID</th>
                                            <th scope="col">수량(최소 단위)</th>
                                            <th scope="col">처분가액</th>
                                            <th scope="col">취득원가</th>
                                            <th scope="col">필요경비</th>
                                            <th scope="col">손익</th>
                                            <th scope="col">계산 방식</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {assetDisposals.map((disposal) => (
                                            <tr key={disposal.movementId}>
                                              <th scope="row">
                                                <strong>
                                                  {disposal.movementId}
                                                </strong>
                                                <small>{disposal.eventId}</small>
                                              </th>
                                              <td className="is-numeric">
                                                {decimal(disposal.quantity)}
                                              </td>
                                              <td className="is-numeric">
                                                <AmountValue
                                                  amount={
                                                    disposal.grossProceeds
                                                  }
                                                  denomination={
                                                    report.denominationAssetId
                                                  }
                                                />
                                              </td>
                                              <td className="is-numeric">
                                                <AmountValue
                                                  amount={disposal.basis}
                                                  denomination={
                                                    report.denominationAssetId
                                                  }
                                                />
                                              </td>
                                              <td className="is-numeric">
                                                <AmountValue
                                                  amount={
                                                    disposal.ancillaryExpense
                                                  }
                                                  denomination={
                                                    report.denominationAssetId
                                                  }
                                                />
                                              </td>
                                              <td className="is-numeric">
                                                <AmountValue
                                                  amount={disposal.gainLoss}
                                                  denomination={
                                                    report.denominationAssetId
                                                  }
                                                />
                                              </td>
                                              <td>
                                                {costMethodLabel(
                                                  disposal.costMethod,
                                                )}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'disposals' ? (
        <section
          id="tax-report-panel-disposals"
          role="tabpanel"
          aria-labelledby="tax-report-tab-disposals"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>DISPOSAL LEDGER</span>
              <h3>처분 장부</h3>
            </div>
            <p>{report.disposals.length.toLocaleString('ko-KR')}건</p>
          </header>
          {report.disposals.length === 0 ? (
            <EmptyRows>이 장부에 포함된 처분이 없습니다.</EmptyRows>
          ) : (
            <div className="tax-report-detail__table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">처분 ID</th>
                    <th scope="col">자산</th>
                    <th scope="col">수량(최소 단위)</th>
                    <th scope="col">처분가액</th>
                    <th scope="col">취득원가</th>
                    <th scope="col">필요경비</th>
                    <th scope="col">손익</th>
                    <th scope="col">계산 방식</th>
                  </tr>
                </thead>
                <tbody>
                  {report.disposals.map((disposal) => (
                    <tr key={disposal.movementId}>
                      <th scope="row">
                        <strong>{disposal.movementId}</strong>
                        <small>{disposal.eventId}</small>
                        <small>
                          {disposal.revisionId} · {disposal.legId}
                        </small>
                      </th>
                      <td>
                        <strong>{disposal.taxAssetId}</strong>
                        <small>{disposal.ledgerAssetId}</small>
                        <small>{disposal.taxAddressId}</small>
                      </td>
                      <td className="is-numeric">
                        {decimal(disposal.quantity)}
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.grossProceeds}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.basis}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.ancillaryExpense}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.gainLoss}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td>{costMethodLabel(disposal.costMethod)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'movements' ? (
        <div
          id="tax-report-panel-movements"
          role="tabpanel"
          aria-labelledby="tax-report-tab-movements"
          className="tax-report-detail__panel"
        >
          <section className="tax-report-detail__section">
            <header>
              <div>
                <span>NON-TAXABLE MOVEMENTS</span>
                <h3>이체</h3>
              </div>
              <p>{report.transfers.length.toLocaleString('ko-KR')}건</p>
            </header>
            {report.transfers.length === 0 ? (
              <EmptyRows>이 장부에 포함된 이체가 없습니다.</EmptyRows>
            ) : (
              <div className="tax-report-detail__table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">이체 ID</th>
                      <th scope="col">자산</th>
                      <th scope="col">수량(최소 단위)</th>
                      <th scope="col">이동 경로</th>
                      <th scope="col">승계 취득원가</th>
                      <th scope="col">계산 방식</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.transfers.map((transfer) => (
                      <tr key={transfer.movementId}>
                        <th scope="row">
                          <strong>{transfer.movementId}</strong>
                          <small>{transfer.eventId}</small>
                          <small>{transfer.revisionId}</small>
                        </th>
                        <td>{transfer.taxAssetId}</td>
                        <td className="is-numeric">
                          {decimal(transfer.quantity)}
                        </td>
                        <td>
                          <strong>{transfer.fromAddressId}</strong>
                          <small>→ {transfer.toAddressId}</small>
                          <small>
                            {transfer.fromLegId} → {transfer.toLegId}
                          </small>
                        </td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={transfer.basis}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                        <td>
                          {costMethodLabel(transfer.fromCostMethod)} →{' '}
                          {costMethodLabel(transfer.toCostMethod)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="tax-report-detail__section">
            <header>
              <div>
                <span>EXCLUDED CONVERSIONS</span>
                <h3>과세 제외 전환</h3>
              </div>
              <p>
                {report.excludedConversions.length.toLocaleString('ko-KR')}건
              </p>
            </header>
            {report.excludedConversions.length === 0 ? (
              <EmptyRows>
                과세 대상에서 제외된 동일 자산 전환이 없습니다.
              </EmptyRows>
            ) : (
              <div className="tax-report-detail__table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">관계 ID</th>
                      <th scope="col">자산</th>
                      <th scope="col">전환 전 최소 단위</th>
                      <th scope="col">전환 후 최소 단위</th>
                      <th scope="col">세무 주소</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.excludedConversions.map((conversion) => (
                      <tr
                        key={`${conversion.eventId}:${conversion.revisionId}:${conversion.relationId}`}
                      >
                        <th scope="row">
                          <strong>{conversion.relationId}</strong>
                          <small>{conversion.eventId}</small>
                          <small>{conversion.revisionId}</small>
                        </th>
                        <td>{conversion.taxAssetId}</td>
                        <td className="is-numeric">
                          {decimal(conversion.fromQuantity)}
                        </td>
                        <td className="is-numeric">
                          {decimal(conversion.toQuantity)}
                        </td>
                        <td>
                          <strong>{conversion.taxAddressId}</strong>
                          <small>
                            {conversion.fromLegId} → {conversion.toLegId}
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'limitations' ? (
        <section
          id="tax-report-panel-limitations"
          role="tabpanel"
          aria-labelledby="tax-report-tab-limitations"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>REVIEW REQUIRED</span>
              <h3>검토가 필요한 항목</h3>
            </div>
            <p>{report.limitations.length.toLocaleString('ko-KR')}건</p>
          </header>
          {report.limitations.length === 0 ? (
            <EmptyRows>
              이 발행본에 기록된 검토 필요 항목이 없습니다.
            </EmptyRows>
          ) : (
            <ul className="tax-report-detail__limitations">
              {report.limitations.map((limitation, index) => {
                const traceFields = [
                  ['세무자산', limitation.taxAssetId],
                  ['세무주소', limitation.taxAddressId],
                  ['이동 ID', limitation.movementId],
                  ['검토 ID', limitation.reviewId],
                  ['검토 revision', limitation.reviewRevisionId],
                ].filter((field): field is [string, string] => Boolean(field[1]))
                return (
                  <li
                    key={`${limitation.code}:${limitation.movementId ?? 'report'}:${index}`}
                  >
                    <span>{limitation.code}</span>
                    <div>
                      <strong>{limitation.reason}</strong>
                      {traceFields.length > 0 ? (
                        <details>
                          <summary>연결된 원장·검토 정보</summary>
                          <dl className="tax-report-detail__limitation-trace">
                            {traceFields.map(([label, value]) => (
                              <div key={label}>
                                <dt>{label}</dt>
                                <dd>{value}</dd>
                              </div>
                            ))}
                          </dl>
                        </details>
                      ) : (
                        <p>이 항목에는 연결 식별자가 기록되지 않았습니다.</p>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}

      {activeTab === 'trace' ? (
        <section
          id="tax-report-panel-trace"
          role="tabpanel"
          aria-labelledby="tax-report-tab-trace"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>METHODOLOGY &amp; TRACE</span>
              <h3>계산 기준과 추적 정보</h3>
            </div>
            <div className="tax-report-detail__trace-actions">
              <p>선택한 revision을 재현하는 데 필요한 식별 정보입니다.</p>
              <a href={evidenceHref} target="_blank" rel="noreferrer">
                근거 JSON 보기
              </a>
            </div>
          </header>
          <dl className="tax-report-detail__methodology">
            <div>
              <dt>Report ID</dt>
              <dd>{report.reportId}</dd>
            </div>
            <div>
              <dt>정책</dt>
              <dd>
                {report.methodology.policy.name}{' '}
                {report.methodology.policy.version}
              </dd>
            </div>
            <div>
              <dt>엔진</dt>
              <dd>
                {report.methodology.engine.name}{' '}
                {report.methodology.engine.version}
              </dd>
            </div>
            <div>
              <dt>Generation ID</dt>
              <dd>{report.methodology.generationId}</dd>
            </div>
            <div>
              <dt>Tax inventory run</dt>
              <dd>{report.methodology.taxInventoryRunId}</dd>
            </div>
            <div>
              <dt>Tax estimate</dt>
              <dd>{report.methodology.taxEstimateId}</dd>
            </div>
            <div>
              <dt>Lot run</dt>
              <dd>{report.methodology.lotRunId}</dd>
            </div>
            <div>
              <dt>Schema digest</dt>
              <dd>{report.methodology.schemaDigest}</dd>
            </div>
            <div>
              <dt>Policy artifact</dt>
              <dd>{report.methodology.policy.artifactDigest}</dd>
            </div>
            <div>
              <dt>Engine artifact</dt>
              <dd>{report.methodology.engine.artifactDigest}</dd>
            </div>
            <div>
              <dt>Report model digest</dt>
              <dd>{report.reportModelDigest}</dd>
            </div>
            <div>
              <dt>Input digest</dt>
              <dd>{report.inputDigest}</dd>
            </div>
            <div>
              <dt>Evidence pack digest</dt>
              <dd>{report.evidencePackDigest}</dd>
            </div>
          </dl>

          <div className="tax-report-detail__evidence">
            <header>
              <div>
                <span>EVIDENCE PACK</span>
                <h4>계산 근거 묶음</h4>
              </div>
              {evidencePack ? (
                <p>
                  {evidencePack.evidenceCoordinates.length.toLocaleString(
                    'ko-KR',
                  )}
                  개 좌표
                </p>
              ) : null}
            </header>

            {evidenceStatus === 'loading' ? (
              <p className="tax-report-detail__evidence-state" role="status">
                계산 근거를 불러오는 중입니다.
              </p>
            ) : null}
            {evidenceStatus === 'not-found' ? (
              <p className="tax-report-detail__evidence-state">
                이 발행본에 연결된 계산 근거를 찾지 못했습니다. 장부 본문은
                계속 확인할 수 있습니다.
              </p>
            ) : null}
            {evidenceStatus === 'error' ? (
              <p
                className="tax-report-detail__evidence-state is-error"
                role="alert"
              >
                계산 근거를 불러오지 못했습니다. 장부 계산 결과 자체의 조회
                실패를 뜻하지 않습니다.
              </p>
            ) : null}

            {evidenceStatus === 'ready' && evidencePack ? (
              <div className="tax-report-detail__evidence-content">
                <dl className="tax-report-detail__evidence-manifest">
                  <div>
                    <dt>Manifest ID</dt>
                    <dd>{evidencePack.manifestId}</dd>
                  </div>
                  <div>
                    <dt>Evidence artifact digest</dt>
                    <dd>{evidencePack.artifactDigest}</dd>
                  </div>
                  <div>
                    <dt>발행 시각</dt>
                    <dd>
                      {new Date(evidencePack.issuedAt).toLocaleString('ko-KR')}
                    </dd>
                  </div>
                </dl>

                <section aria-labelledby="tax-report-artifact-roots-title">
                  <header>
                    <h5 id="tax-report-artifact-roots-title">Artifact roots</h5>
                    <p>
                      {evidencePack.artifactRoots.length.toLocaleString('ko-KR')}
                      개
                    </p>
                  </header>
                  {evidencePack.artifactRoots.length === 0 ? (
                    <EmptyRows>기록된 artifact root가 없습니다.</EmptyRows>
                  ) : (
                    <>
                      <ul className="tax-report-detail__artifact-roots">
                        {artifactRootsPreview.map((root, index) => (
                          <li key={`${root.kind}:${root.digest}:${index}`}>
                            <strong>{root.kind}</strong>
                            <code>{root.digest}</code>
                          </li>
                        ))}
                      </ul>
                      {evidencePack.artifactRoots.length >
                      artifactRootsPreview.length ? (
                        <p className="tax-report-detail__preview-limit">
                          화면에는 앞의{' '}
                          {artifactRootsPreview.length.toLocaleString('ko-KR')}
                          개만 표시합니다. 전체 목록은 근거 JSON 조회에서
                          확인할 수 있습니다.
                        </p>
                      ) : null}
                    </>
                  )}
                </section>

                <section aria-labelledby="tax-report-evidence-kinds-title">
                  <header>
                    <h5 id="tax-report-evidence-kinds-title">근거 종류</h5>
                    <p>종류별 좌표 수</p>
                  </header>
                  {evidenceKindCounts &&
                  Object.keys(evidenceKindCounts).length > 0 ? (
                    <dl className="tax-report-detail__evidence-kinds">
                      {Object.entries(evidenceKindCounts)
                        .sort(([left], [right]) =>
                          left.localeCompare(right),
                        )
                        .map(([kind, count]) => (
                          <div key={kind}>
                            <dt>{kind}</dt>
                            <dd>{count.toLocaleString('ko-KR')}개</dd>
                          </div>
                        ))}
                    </dl>
                  ) : (
                    <EmptyRows>기록된 근거 좌표가 없습니다.</EmptyRows>
                  )}
                </section>

                <section aria-labelledby="tax-report-coordinate-preview-title">
                  <header>
                    <div>
                      <h5 id="tax-report-coordinate-preview-title">
                        근거 좌표 미리보기
                      </h5>
                      <p>
                        화면에는 최대 12개만 표시합니다. 전체 좌표는 근거 JSON
                        원본에서 확인할 수 있습니다.
                      </p>
                    </div>
                    <span>
                      {`${evidenceCoordinatesPreview.length.toLocaleString(
                        'ko-KR',
                      )}/${evidencePack.evidenceCoordinates.length.toLocaleString(
                        'ko-KR',
                      )}`}
                    </span>
                  </header>
                  {evidenceCoordinatesPreview.length === 0 ? (
                    <EmptyRows>미리 볼 근거 좌표가 없습니다.</EmptyRows>
                  ) : (
                    <ol className="tax-report-detail__evidence-coordinates">
                      {evidenceCoordinatesPreview.map((coordinate, index) => (
                        <li key={`${coordinate.kind}:${index}`}>
                          <strong>{coordinate.kind}</strong>
                          <dl>
                            {evidenceCoordinateFields.map(({ key, label }) => {
                              const value = coordinate[key]
                              return value ? (
                                <div key={key}>
                                  <dt>{label}</dt>
                                  <dd>{value}</dd>
                                </div>
                              ) : null
                            })}
                          </dl>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </article>
  )
}
