import { useState } from 'react'

import type {
  TaxReportModel,
  TaxReportV2AmountModel,
  TaxReportV2AccountModel,
  TaxReportV2DetailModel,
  TaxReportV2RowReviewModel,
  TaxReportV2SourceEvidenceModel,
  TaxReportV2ValuationModel,
} from './taxReportApi.ts'
import { ReportAttestationControl } from './ReportAttestationControl.tsx'
import { formatLedgerQuantity } from '../ledger/ledgerPresentation.ts'

type V2Tab = 'summary' | 'assets' | 'events' | 'basis'

const tabs: Array<{ id: V2Tab; label: string }> = [
  { id: 'summary', label: '세금 요약' },
  { id: 'assets', label: '자산별 장부' },
  { id: 'events', label: '소득·처분' },
  { id: 'basis', label: '계산·법적 근거' },
]

const decimalLabel = (value: string) => {
  const [integer = '', fraction] = value.split('.', 2)
  const sign = integer.startsWith('-') ? '-' : ''
  const digits = sign ? integer.slice(1) : integer
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

const reportDenominations: Record<
  string,
  { symbol: string; decimals: number }
> = {
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}

const amountLabel = (
  value: TaxReportV2AmountModel,
  denomination: string,
) => {
  if (!value.hasAmount || value.amount === null) return '미확정'
  const presentation = reportDenominations[denomination]
  if (presentation) {
    return `${formatLedgerQuantity(
      value.amount,
      presentation.decimals,
    )} ${presentation.symbol}`
  }
  return `${decimalLabel(value.amount)} ${denomination}`
}

const dateLabel = (value: string) =>
  `${new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value))} KST`

const dateTimeLabel = (value: string) =>
  `${new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: 'Asia/Seoul',
  }).format(new Date(value))} KST`

const intervalLabel = ({ from, through }: { from: string; through: string }) =>
  `${dateTimeLabel(from)} ~ ${dateTimeLabel(through)}`

const statusLabel: Record<string, string> = {
  FINAL: '확정',
  PROVISIONAL: '잠정',
  COMPLETE: '계산 완료',
  BLOCKED: '계산 차단',
  TAX_DUE: '신고 예상 세액 있음',
  ESTIMATED_TAX_DUE: '추정 세액 있음',
  TAX_ZERO: '예상 세액 없음',
  SIMULATED_TAX_DUE: '시뮬레이션 세액 있음',
  SIMULATED_TAX_ZERO: '시뮬레이션 세액 없음',
  NO_TAX_EVENTS: '과세 이벤트 없음',
  INCOMPLETE: '계산 미완료',
  ACTUAL_TOTAL_AVERAGE: '실제 취득가액 · 연간 총평균',
  DEEMED_EXPENSE_50: '50% 필요경비 특례',
  ENACTED: '시행 정책',
  SIMULATION: '정책 시뮬레이션',
}

function Amount({
  value,
  denomination,
}: {
  value: TaxReportV2AmountModel
  denomination: string
}) {
  return (
    <strong data-certainty={value.status}>
      {amountLabel(value, denomination)}
    </strong>
  )
}

const accountLabel = (account: TaxReportV2AccountModel) => [
  account.displayName,
  account.accountKind,
  account.accountId,
].filter((value): value is string => value !== null).join(' · ') || '계정 미확인'

function EventEvidence({
  reportId,
  occurredAt,
  account,
  from,
  to,
  valuation,
  sourceEvidence,
  review,
  financials = [],
}: {
  reportId: string
  occurredAt: string
  account?: TaxReportV2AccountModel
  from?: TaxReportV2AccountModel
  to?: TaxReportV2AccountModel
  valuation?: TaxReportV2ValuationModel
  sourceEvidence: TaxReportV2SourceEvidenceModel[]
  review: TaxReportV2RowReviewModel
  financials?: Array<{ label: string; value: string }>
}) {
  const sourceKinds = [...new Set(sourceEvidence.flatMap(
    (source) => source.sourceKinds,
  ))]
  const allBound = sourceEvidence.length > 0 && sourceEvidence.every(
    (source) => source.sourceArtifactBindingStatus === 'BOUND',
  )
  return (
    <dl className="tax-report-v2__row-detail">
      <div><dt>거래 일시</dt><dd>{dateTimeLabel(occurredAt)}</dd></div>
      {account ? <div><dt>거래소·지갑</dt><dd>{accountLabel(account)}</dd></div> : null}
      {from && to ? <div><dt>이동 경로</dt><dd>{accountLabel(from)} → {accountLabel(to)}</dd></div> : null}
      {valuation ? <>
        <div><dt>적용 가격·환율 시점</dt><dd>{valuation.effectiveAt ? dateTimeLabel(valuation.effectiveAt) : '미확정'} · {valuation.kind ?? '평가 종류 미확정'}</dd></div>
        <div><dt>평가 근거</dt><dd>{valuation.quoteId ?? valuation.valuationId ?? '미확정'} · {valuation.status}</dd></div>
      </> : null}
      {financials.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
      <div><dt>데이터 출처</dt><dd>{sourceKinds.join(', ') || '출처 미확인'} · {allBound ? '원본 결합 완료' : '원본 결합 검토 필요'}</dd></div>
      <div className="tax-report-v2__evidence-path">
        <dt>근거 좌표</dt>
        <dd>
          {sourceEvidence.length === 0 ? '근거 좌표 없음' : sourceEvidence.map((source) => (
            <span key={`${source.fragmentId}-${source.observationId}`}>
              fragment {source.fragmentId} · observation {source.observationId}<br />
              artifact {source.sourceArtifactIds.join(', ') || '미결합'}
            </span>
          ))}
          <a href={`/api/v1/tax-reports/${encodeURIComponent(reportId)}/evidence`} target="_blank" rel="noreferrer">
            EvidencePack 열기
          </a>
        </dd>
      </div>
      <div><dt>사용자 확인</dt><dd>{review.status === 'CLEAR' ? '추가 확인 없음' : review.limitations.map((item) => item.reason).join(', ')}</dd></div>
    </dl>
  )
}

function EventRow({
  reportId,
  label,
  amount,
  quantity,
  occurredAt,
  account,
  from,
  to,
  valuation,
  sourceEvidence,
  review,
  financials,
}: {
  reportId: string
  label: string
  amount: string
  quantity: string
  occurredAt: string
  account?: TaxReportV2AccountModel
  from?: TaxReportV2AccountModel
  to?: TaxReportV2AccountModel
  valuation?: TaxReportV2ValuationModel
  sourceEvidence: TaxReportV2SourceEvidenceModel[]
  review: TaxReportV2RowReviewModel
  financials?: Array<{ label: string; value: string }>
}) {
  return (
    <details className="tax-report-v2__row">
      <summary>
        <span>{label}</span>
        <strong>{amount}</strong>
        <small>{dateLabel(occurredAt)} · 원천 최소단위 수량 {quantity}</small>
      </summary>
      <EventEvidence
        reportId={reportId}
        occurredAt={occurredAt}
        account={account}
        from={from}
        to={to}
        valuation={valuation}
        sourceEvidence={sourceEvidence}
        review={review}
        financials={financials}
      />
    </details>
  )
}

export function TaxReportDetailV2({
  report,
  pointerVersion,
  isCurrent = false,
  generationState,
  filingStatus,
}: {
  report: TaxReportV2DetailModel
  pointerVersion?: TaxReportModel['pointerVersion']
  isCurrent?: boolean
  generationState?: 'ACTIVE' | 'REVIEW_REQUIRED'
  filingStatus?: TaxReportModel['filingStatus']
}) {
  const [activeTab, setActiveTab] = useState<V2Tab>('summary')
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false)
  const pdfHref =
    `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`
  const partialCoverage = report.dataCoverage.status !== 'COMPLETE'
  const policy = report.methodology.policy
  const verifiedCoverage = [
    'DOCUMENT_METADATA_VERIFIED',
    'CHAIN_VERIFIED',
  ].includes(report.dataCoverage.assurance)
  const attestationEligible =
    isCurrent &&
    generationState === 'ACTIVE' &&
    filingStatus === 'READY' &&
    report.reportFinality === 'FINAL' &&
    report.status === 'FINAL' &&
    report.calculationStatus === 'COMPLETE' &&
    report.taxYearCloseStatus === 'CLOSED' &&
    report.dataCoverage.status === 'COMPLETE' &&
    verifiedCoverage

  return (
    <article className="tax-report-v2" aria-labelledby="tax-report-v2-title">
      <header className="tax-report-v2__header">
        <div>
          <span className="tax-report-v2__eyebrow">TAX ENGINE RESULT</span>
          <h2 id="tax-report-v2-title">{report.taxYear}년 가상자산 세무 장부</h2>
          <p>
            {pointerVersion === undefined
              ? '발행본'
              : `revision ${String(pointerVersion)}`}
            {isCurrent ? ' · 현재 장부' : ' · 이전 발행본'} ·{' '}
            {dateLabel(report.issuedAt)} 발행
          </p>
        </div>
        <div className="tax-report-v2__pdf-actions">
          <button type="button" onClick={() => setPdfPreviewOpen(true)}>PDF 미리보기</button>
          <a className="tax-report-v2__pdf" href={pdfHref} download>PDF 내려받기</a>
        </div>
      </header>

      <div className="tax-report-v2__meta" aria-label="장부 상태">
        <span>{statusLabel[policy.applicationMode] ?? policy.applicationMode}</span>
        <span>{statusLabel[report.reportFinality] ?? report.reportFinality}</span>
        <span>{statusLabel[report.calculationStatus] ?? report.calculationStatus}</span>
        <span>{statusLabel[report.taxOutcome] ?? report.taxOutcome}</span>
        <span>{report.taxYearCloseStatus === 'CLOSED' ? '연간 마감' : '연중 추정'}</span>
      </div>

      <ReportAttestationControl
        reportId={report.reportId}
        reportModelDigest={report.reportModelDigest}
        pointerVersion={pointerVersion ?? 1}
        eligible={attestationEligible}
      />

      {partialCoverage ? (
        <aside className="tax-report-v2__coverage" role="note">
          <div>
            <strong>현재 확보된 데이터 범위로 계산한 연중 추정 장부입니다.</strong>
            <p>
              과세기간 {dateLabel(report.inputPeriod.from)} ~{' '}
              {dateLabel(report.inputPeriod.through)} 중{' '}
              표시 경계는 <b>{dateLabel(report.dataCoverage.from)} ~ {dateLabel(report.dataCoverage.through)}</b>
              입니다. 실제 반영 여부는 아래 포함·누락 구간으로 판단하며, 자료를 추가하면 Tax Engine이 전체 연도를 다시 계산합니다.
            </p>
            <dl className="tax-report-v2__coverage-intervals">
              <div><dt>포함 구간</dt><dd>{report.dataCoverage.coveredIntervals.map(intervalLabel).join(', ') || '확인된 구간 없음'}</dd></div>
              <div><dt>누락 구간</dt><dd>{report.dataCoverage.uncoveredIntervals.map(intervalLabel).join(', ') || '없음'}</dd></div>
            </dl>
          </div>
          <span>{report.dataCoverage.status}</span>
        </aside>
      ) : null}

      <nav
        className="tax-report-v2__tabs"
        aria-label="장부 상세 보기"
        role="tablist"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tax-report-v2-tab-${tab.id}`}
            aria-controls={`tax-report-v2-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'summary' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-summary" aria-labelledby="tax-report-v2-tab-summary">
          <header>
            <div>
              <span>ANNUAL TAX SUMMARY</span>
              <h3>세금 계산 결과</h3>
            </div>
            <p>표시값은 Tax Engine의 정본이며 브라우저에서 다시 계산하지 않습니다.</p>
          </header>
          <div className="tax-report-v2__kpis">
            <article className="is-primary">
              <span>예상 총세액</span>
              <Amount value={report.summary.totalTax} denomination={report.denominationAssetId} />
              <small>{statusLabel[report.taxOutcome] ?? report.taxOutcome}</small>
            </article>
            <article>
              <span>연간 처분손익</span>
              <Amount value={report.summary.disposalGainLoss} denomination={report.denominationAssetId} />
            </article>
            <article>
              <span>대여 순소득</span>
              <Amount value={report.summary.netLendingIncome} denomination={report.denominationAssetId} />
            </article>
            <article>
              <span>과세소득</span>
              <Amount value={report.summary.taxableIncome} denomination={report.denominationAssetId} />
            </article>
          </div>
          <div className="tax-report-v2__summary-grid">
            <section>
              <h4>연간 처분 금액</h4>
              <dl>
                <div><dt>총 처분가액</dt><dd><Amount value={report.summary.grossProceeds} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>총 취득가액 · 처분 취득원가</dt><dd><Amount value={report.summary.disposedBasis} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>총 필요경비</dt><dd><Amount value={report.summary.deductibleExpense} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>원천 실제 발생비용</dt><dd><Amount value={report.summary.incurredExpense} denomination={report.denominationAssetId} /></dd></div>
              </dl>
            </section>
            <section>
              <h4>세액 구성</h4>
              <dl>
                <div><dt>과세표준</dt><dd><Amount value={report.summary.taxableBase} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>국세</dt><dd><Amount value={report.summary.nationalTax} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>지방세</dt><dd><Amount value={report.summary.localTax} denomination={report.denominationAssetId} /></dd></div>
                <div><dt>기본공제 / 실제 적용</dt><dd>{amountLabel({ status: 'KNOWN', hasAmount: true, amount: report.summary.calculationRule.basicDeductionAmount }, report.denominationAssetId)} / {report.summary.calculationRule.deductionUsedAmount === null ? '미확정' : amountLabel({ status: 'KNOWN', hasAmount: true, amount: report.summary.calculationRule.deductionUsedAmount }, report.denominationAssetId)}</dd></div>
              </dl>
            </section>
            <section>
              <h4>현재 장부 판단</h4>
              <dl>
                <div><dt>신고 조치</dt><dd>{report.filingAction}</dd></div>
                <div><dt>신고 제출</dt><dd>{report.filingSubmissionStatus}</dd></div>
                <div><dt>가격 확정성</dt><dd>{statusLabel[report.valuationFinality] ?? report.valuationFinality}</dd></div>
                <div><dt>마지막 계산</dt><dd>{dateTimeLabel(report.calculatedAsOf)}</dd></div>
              </dl>
            </section>
          </div>
        </section>
      ) : null}

      {activeTab === 'assets' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-assets" aria-labelledby="tax-report-v2-tab-assets">
          <header>
            <div><span>ASSET LEDGER</span><h3>자산별 연간 총평균 장부</h3></div>
            <p>{report.assetSummaries.length}개 자산</p>
          </header>
          {report.assetSummaries.length === 0 ? <p className="tax-report-v2__empty">표시할 자산이 없습니다.</p> : (
            <div className="tax-report-v2__asset-list">
              {report.assetSummaries.map((asset) => (
                <article key={asset.taxAssetId}>
                  <header><h4>{asset.taxAssetId}</h4><span>{statusLabel[asset.basisMode] ?? asset.basisMode}</span></header>
                  <div className="tax-report-v2__average">
                    <div><span>총평균 분자 · 연간 취득가액(원천 정수)</span><strong>{asset.annualAverage.numerator ? decimalLabel(asset.annualAverage.numerator) : '미확정'}</strong></div>
                    <div><span>총평균 분모 · 연간 취득수량(원천 정수)</span><strong>{asset.annualAverage.denominator ? decimalLabel(asset.annualAverage.denominator) : '미확정'}</strong></div>
                    <div><span>연간 총평균 단가(원천 정수)</span><strong>{asset.annualAverage.unitCost ? decimalLabel(asset.annualAverage.unitCost) : '미확정'}</strong></div>
                    <div><span>정확 단가 비율(원천 정수)</span><strong>{asset.annualAverage.unitCostNumerator ? decimalLabel(asset.annualAverage.unitCostNumerator) : '—'} / {asset.annualAverage.unitCostDenominator ? decimalLabel(asset.annualAverage.unitCostDenominator) : '—'}</strong></div>
                  </div>
                  <dl>
                    <div><dt>기초수량(원천 최소단위) · 기초가액</dt><dd>{asset.openingQuantity} · {amountLabel(asset.openingBasis, report.denominationAssetId)}</dd></div>
                    <div><dt>연간 취득수량(원천 최소단위) · 취득가액</dt><dd>{asset.acquiredQuantity} · {amountLabel(asset.acquisitionCost, report.denominationAssetId)}</dd></div>
                    <div><dt>처분수량(원천 최소단위) · 처분가액</dt><dd>{asset.disposedQuantity} · {amountLabel(asset.grossProceeds, report.denominationAssetId)}</dd></div>
                    <div><dt>처분 취득가액</dt><dd>{amountLabel(asset.disposedBasis, report.denominationAssetId)}</dd></div>
                    <div><dt>수수료·필요경비</dt><dd>{amountLabel(asset.deductibleExpense, report.denominationAssetId)}</dd></div>
                    <div><dt>자산별 손익</dt><dd>{amountLabel(asset.gainLoss, report.denominationAssetId)}</dd></div>
                    <div><dt>기말수량(원천 최소단위) · 기말가액</dt><dd>{asset.endingQuantity} · {amountLabel(asset.endingCost, report.denominationAssetId)}</dd></div>
                  </dl>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'events' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-events" aria-labelledby="tax-report-v2-tab-events">
          <header>
            <div><span>TAX EVENTS</span><h3>소득·취득·처분 내역</h3></div>
            <p>수수료 자산 처분은 일반 처분과 분리합니다.</p>
          </header>
          <div className="tax-report-v2__event-grid">
            <section>
              <h4>대여·기타 소득 <span>{report.incomeRows.length}</span></h4>
              {report.incomeRows.length === 0 ? <p>해당 내역이 없습니다.</p> : report.incomeRows.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${row.transactionType} · ${row.taxAssetId}`}
                  amount={amountLabel(row.income, report.denominationAssetId)}
                  quantity={row.quantity} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review} />
              ))}
            </section>
            <section>
              <h4>보상자산 취득 <span>{report.acquisitions.length}</span></h4>
              {report.acquisitions.length === 0 ? <p>해당 내역이 없습니다.</p> : report.acquisitions.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${row.transactionType} · ${row.taxAssetId}`}
                  amount={amountLabel(row.acquisitionCost, report.denominationAssetId)}
                  quantity={row.quantity} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review} />
              ))}
            </section>
            <section>
              <h4>일반 처분 <span>{report.disposals.length}</span></h4>
              {report.disposals.length === 0 ? <p>해당 내역이 없습니다.</p> : report.disposals.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${row.transactionType} · ${row.taxAssetId} · ${statusLabel[row.basisMode] ?? row.basisMode}`}
                  amount={amountLabel(row.gainLoss, report.denominationAssetId)}
                  quantity={row.quantity} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[
                    { label: '총 처분가액', value: amountLabel(row.grossProceeds, report.denominationAssetId) },
                    { label: '취득원가', value: amountLabel(row.basis, report.denominationAssetId) },
                    { label: '필요경비', value: amountLabel(row.ancillaryExpense, report.denominationAssetId) },
                    { label: '원천 실제 발생비용', value: amountLabel(row.incurredExpense, report.denominationAssetId) },
                    { label: '처분 손익', value: amountLabel(row.gainLoss, report.denominationAssetId) },
                  ]} />
              ))}
            </section>
            <section>
              <h4>수수료 자산 별도 처분 <span>{report.feeAssetDisposals.length}</span></h4>
              {report.feeAssetDisposals.length === 0 ? <p>해당 내역이 없습니다.</p> : report.feeAssetDisposals.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${row.taxAssetId} · ${row.transactionType}`}
                  amount={amountLabel(row.gainLoss, report.denominationAssetId)}
                  quantity={row.quantity} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[
                    { label: '수수료 자산 처분가액', value: amountLabel(row.grossProceeds, report.denominationAssetId) },
                    { label: '수수료 자산 취득원가', value: amountLabel(row.basis, report.denominationAssetId) },
                    { label: '처분 손익', value: amountLabel(row.gainLoss, report.denominationAssetId) },
                  ]} />
              ))}
            </section>
            <section>
              <h4>원가 이어받기 이체 <span>{report.transfers.length}</span></h4>
              {report.transfers.length === 0 ? <p>해당 내역이 없습니다.</p> : report.transfers.map((row) => (
                <EventRow key={row.movementId} reportId={report.reportId}
                  label={`${row.transactionType} · ${row.taxAssetId}`}
                  amount={amountLabel(row.basis, report.denominationAssetId)}
                  quantity={row.quantity} occurredAt={row.occurredAt}
                  from={row.from} to={row.to}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[{ label: '이어받은 취득원가', value: amountLabel(row.basis, report.denominationAssetId) }]} />
              ))}
            </section>
            <section>
              <h4>비과세 자기이체 <span>{report.nonTaxableTransfers.length}</span></h4>
              {report.nonTaxableTransfers.length === 0 ? <p>해당 내역이 없습니다.</p> : report.nonTaxableTransfers.map((row) => (
                <EventRow key={row.movementId} reportId={report.reportId}
                  label={`${row.transactionType} · ${row.taxAssetId}`}
                  amount="비과세" quantity={row.quantity} occurredAt={row.occurredAt}
                  from={row.from} to={row.to}
                  sourceEvidence={row.sourceEvidence} review={row.review} />
              ))}
            </section>
            <section>
              <h4>처분 제외 교환 <span>{report.excludedConversions.length}</span></h4>
              {report.excludedConversions.length === 0 ? <p>해당 내역이 없습니다.</p> : report.excludedConversions.map((row) => (
                <div className="tax-report-v2__excluded" key={row.relationId}>
                  <strong>{row.taxAssetId}</strong>
                  <span>원천 최소단위 {row.fromQuantity} → {row.toQuantity}</span>
                  <small>relation {row.relationId}</small>
                </div>
              ))}
            </section>
          </div>
        </section>
      ) : null}

      {activeTab === 'basis' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-basis" aria-labelledby="tax-report-v2-tab-basis">
          <header>
            <div><span>POLICY &amp; EVIDENCE</span><h3>계산 규칙과 법적 근거</h3></div>
            <p>이 발행본에 고정된 정책 버전과 적용기간입니다.</p>
          </header>
          <div className="tax-report-v2__basis-grid">
            <section>
              <h4>계산 규칙</h4>
              <dl>
                <div><dt>원가 묶음</dt><dd>거주자 × 과세연도 × 세무자산</dd></div>
                <div><dt>원가 방식</dt><dd>연간 총평균법</dd></div>
                <div><dt>국세율</dt><dd>{report.summary.calculationRule.nationalRate.numerator} / {report.summary.calculationRule.nationalRate.denominator}</dd></div>
                <div><dt>지방세율</dt><dd>{report.summary.calculationRule.localRate.numerator} / {report.summary.calculationRule.localRate.denominator}</dd></div>
                <div><dt>세액 반올림</dt><dd>{report.summary.calculationRule.taxRounding}</dd></div>
                <div><dt>원가 배분 반올림</dt><dd>{report.summary.calculationRule.basisAllocationRounding}</dd></div>
              </dl>
            </section>
            <section>
              <h4>{policy.name} · {policy.version}</h4>
              <p>{dateLabel(policy.effectiveFrom)} ~ {dateLabel(policy.effectiveThrough)} 적용</p>
              <ul className="tax-report-v2__legal">
                {policy.legalReferences.map((reference) => (
                  <li key={`${reference.law}-${reference.article}-${reference.paragraphs.join('-')}`}>
                    <strong>{reference.law} {reference.article}{reference.paragraphs.length > 0 ? ` ${reference.paragraphs.join(', ')}` : ''}</strong>
                    <span>{reference.purpose}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section className="tax-report-v2__sources">
            <h4>실제 계산 데이터 범위</h4>
            {report.sourceCoverage.map((source) => (
              <div key={source.sourceArtifactId}>
                <strong>{source.sourceKind}</strong>
                <span>{source.status} · {source.assurance}</span>
                <small>포함: {source.coveredIntervals.map(intervalLabel).join(', ') || '검증된 구간 없음'}</small>
                <small>누락: {source.uncoveredIntervals.map(intervalLabel).join(', ') || '없음'}</small>
                <a href={`/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/evidence`} target="_blank" rel="noreferrer">EvidencePack에서 원본 근거 확인</a>
              </div>
            ))}
          </section>
          {report.limitations.length > 0 ? (
            <section className="tax-report-v2__limitations">
              <h4>검토할 항목</h4>
              {report.limitations.map((item, index) => (
                <div key={`${item.code}-${item.movementId ?? index}`}>
                  <strong>{item.code}</strong><span>{item.reason}</span>
                </div>
              ))}
            </section>
          ) : null}
        </section>
      ) : null}
      {pdfPreviewOpen ? (
        <div className="tax-report-v2__pdf-dialog" role="dialog" aria-modal="true" aria-labelledby="tax-report-v2-pdf-title">
          <div>
            <header>
              <h3 id="tax-report-v2-pdf-title">PDF 미리보기</h3>
              <button type="button" onClick={() => setPdfPreviewOpen(false)} aria-label="PDF 미리보기 닫기">닫기</button>
            </header>
            <iframe title={`${report.taxYear}년 세무 장부 PDF`} src={pdfHref} />
            <a className="tax-report-v2__pdf" href={pdfHref} download>PDF 내려받기</a>
          </div>
        </div>
      ) : null}
    </article>
  )
}
