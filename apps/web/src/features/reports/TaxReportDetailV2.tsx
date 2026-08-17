import { useEffect, useState } from 'react'

import { requestRaw } from '../../api/client.ts'
import { AppLink } from '../../components/AppLink.tsx'
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
import type { ReportAssetPresentations } from './reportAssetPresentation.ts'

type V2Tab = 'summary' | 'assets' | 'events' | 'basis' | 'verification'

const tabs: Array<{ id: V2Tab; label: string }> = [
  { id: 'summary', label: '세금 요약' },
  { id: 'assets', label: '자산별 장부' },
  { id: 'events', label: '소득·처분' },
  { id: 'basis', label: '계산·법적 근거' },
  { id: 'verification', label: 'EAS 증빙' },
]

const reportDenominationSymbols: Record<string, string> = {
  'asset-krw-upbit': 'KRW',
  KRW: 'KRW',
}

const amountLabel = (
  value: TaxReportV2AmountModel,
  denomination: string,
  denominationAtomicDecimals: number,
) => {
  if (!value.hasAmount || value.amount === null) return '미확정'
  const symbol = reportDenominationSymbols[denomination]
  if (!symbol) return '금액 단위 확인 필요'
  return `${formatLedgerQuantity(
    value.amount,
    denominationAtomicDecimals,
  )} ${symbol}`
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

const chainLabels: Record<string, string> = {
  '1': 'Ethereum',
  '10': 'Optimism',
}

const compactCoordinate = (value: string) =>
  value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-6)}` : value

const taxAssetLabel = (taxAssetId: string) => {
  const match = /^asset:eip155:(\d+):(.+)$/.exec(taxAssetId)
  if (!match?.[1] || !match[2]) return '자산 정보 확인 필요'
  const [, chainId, assetReference] = match
  const chain = chainLabels[chainId] ?? '연결된 체인'
  return assetReference === 'native'
    ? `${chain} · 네이티브 자산`
    : `${chain} · ${compactCoordinate(assetReference)}`
}

const statusLabel: Record<string, string> = {
  FINAL: '확정',
  PROVISIONAL: '잠정',
  COMPLETE: '계산 완료',
  BLOCKED: '계산 차단',
  TAX_DUE: '신고 예상 세액 있음',
  ESTIMATED_TAX_DUE: '추정 세액 있음',
  TAX_ZERO: '예상 세액 없음',
  ESTIMATED_TAX_ZERO: '추정 세액 없음',
  SIMULATED_TAX_DUE: '시뮬레이션 세액 있음',
  SIMULATED_TAX_ZERO: '시뮬레이션 세액 없음',
  NO_TAX_EVENTS: '과세 이벤트 없음',
  INCOMPLETE: '계산 미완료',
  ACTUAL_TOTAL_AVERAGE: '실제 취득가액 · 연간 총평균',
  DEEMED_EXPENSE_50: '50% 필요경비 특례',
  ENACTED: '시행 정책',
  SIMULATION: '정책 시뮬레이션',
}

const transactionLabel: Record<string, string> = {
  ACQUIRE: '취득',
  OTHER_ACQUISITION: '기타 취득',
  DISPOSAL: '매도·사용',
  FEE_ASSET_DISPOSAL: '수수료로 사용한 자산 처분',
  LENDING_INCOME_CASH: '대여 수익(원화)',
  LENDING_INCOME_ASSET: '대여 수익(자산)',
  TRANSFER: '취득원가 이월 이체',
  SELF_TRANSFER: '본인 계정 간 이동',
}

const incomePolicySubtypeLabel: Record<string, string> = {
  AIRDROP: '에어드롭',
  STAKING_REWARD: '스테이킹 보상',
  HARD_FORK: '하드포크 취득',
  MINING_REWARD: '채굴 보상',
}

const limitationPresentation: Record<string, { title: string; description: string }> = {
  TRANSFER_ENDPOINT_REVIEW_REQUIRED: {
    title: '이체 상대 정보를 확인해 주세요',
    description: '본인 지갑 간 이동인지 외부 거래인지 확인할 근거가 더 필요합니다.',
  },
  OPENING_INVENTORY_MISSING: {
    title: '이전 보유 내역이 부족합니다',
    description: '처분 전 보유 수량과 취득원가를 확인할 수 있는 이전 장부가 충분하지 않습니다.',
  },
  SOURCE_COVERAGE_UNVERIFIED: {
    title: '자료 수집 범위를 확인해 주세요',
    description: '계산에 사용한 자료 중 기간이 검증되지 않은 항목이 있습니다.',
  },
  FILING_ROUNDING_PROFILE_UNAPPROVED: {
    title: '신고용 반올림 기준 확인이 필요합니다',
    description: '현재 세액은 신고 전 추정치입니다.',
  },
  UNKNOWN_OPENING_BASIS: {
    title: '기초 보유분의 취득가액 확인이 필요합니다',
    description: '이전 보유분은 확인되지만, 취득가액을 확정할 자료가 부족합니다.',
  },
  UNKNOWN_DISPOSAL_BASIS: {
    title: '처분 자산의 취득가액 확인이 필요합니다',
    description: '처분한 자산의 취득원가를 확정할 자료가 부족합니다.',
  },
  UNKNOWN_TRANSFER_BASIS: {
    title: '이체 전후 취득원가 연결 확인이 필요합니다',
    description: '본인 계정 간 이동한 자산의 취득원가 연결을 확인해야 합니다.',
  },
  UNKNOWN_ACQUISITION_BASIS: {
    title: '취득 시점의 가격 정보 확인이 필요합니다',
    description: '취득가액을 확정할 수 있는 가격 자료가 부족합니다.',
  },
  PROVISIONAL_ACQUISITION_VALUE: {
    title: '취득 가격이 잠정값입니다',
    description: '취득가액을 확정하기 전의 가격 자료로 계산했습니다.',
  },
  UNKNOWN_ACQUISITION_EXPENSE: {
    title: '취득 부대비용 확인이 필요합니다',
    description: '취득가액에 포함되는 비용을 확정할 자료가 부족합니다.',
  },
  UNKNOWN_DISPOSAL_EXPENSE: {
    title: '처분 비용 확인이 필요합니다',
    description: '처분가액에서 차감되는 비용을 확정할 자료가 부족합니다.',
  },
  SOURCE_EVIDENCE_MISSING: {
    title: '원본 거래 자료가 필요합니다',
    description: '이 계산 행을 뒷받침하는 원본 자료를 확인할 수 없습니다.',
  },
  SOURCE_EVIDENCE_UNBOUND: {
    title: '거래와 원본 자료의 연결 확인이 필요합니다',
    description: '원본 자료는 있으나 이 계산 행과의 연결을 확인해야 합니다.',
  },
  VALUATION_REVIEW_REQUIRED: {
    title: '거래 시점 가격 확인이 필요합니다',
    description: '계산에 사용한 가격을 검토해야 합니다.',
  },
  VALUATION_TRACE_INCOMPLETE: {
    title: '가격 산정 근거가 불완전합니다',
    description: '가격이 만들어진 경로의 일부 정보를 확인할 수 없습니다.',
  },
  VALUATION_DISPLAY_PROVENANCE_INCOMPLETE: {
    title: '가격 출처 정보가 불완전합니다',
    description: '가격 데이터의 공급자·시장 정보 중 일부가 부족합니다.',
  },
  OPENING_BASIS_PROVENANCE_INCOMPLETE: {
    title: '기초가액 산정 근거 확인이 필요합니다',
    description: '기초가액에 적용한 규칙 또는 이전 확정 장부의 근거가 부족합니다.',
  },
  UNRESOLVED_TAX_CHARACTERIZATION: {
    title: '거래 성격 확인이 필요합니다',
    description: '이 거래를 어떤 세무 항목으로 처리할지 확인해야 합니다.',
  },
  UNRESOLVED_TRANSFER_TAX_TREATMENT: {
    title: '이체의 세무 처리 확인이 필요합니다',
    description: '본인 간 이동인지 처분인지 판단할 정보가 부족합니다.',
  },
  CEX_TRANSFER_COUNTERPARTY_UNKNOWN: {
    title: '거래소 이체 상대 확인이 필요합니다',
    description: '거래소 이체의 상대 계정 또는 지갑을 확인해야 합니다.',
  },
  MISSING_FEE_VALUATION: {
    title: '수수료 자산 가격 확인이 필요합니다',
    description: '수수료로 사용한 자산의 거래 시점 가격이 부족합니다.',
  },
  INVENTORY_CALCULATION_INCOMPLETE: {
    title: '보유 내역 계산이 아직 끝나지 않았습니다',
    description: '보유수량과 취득원가를 다시 계산한 뒤 결과를 확정할 수 있습니다.',
  },
}

const roundingLabel: Record<string, string> = {
  FLOOR: '원 단위 미만 절사',
  CUMULATIVE_FLOOR_ANNUAL_POOL: '연간 총평균 기준으로 누적 배분 후 절사',
  CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS: '50% 필요경비 기준으로 누적 배분 후 절사',
}

const openingBasisLabel: Record<string, string> = {
  ACTUAL_ACQUISITION_COST: '실제 취득가액',
  PRE_EFFECTIVE_MAX_OF_ACTUAL_OR_MARKET: '실제 취득가액과 기준일 시가 중 큰 금액',
  PRIOR_FINAL_RUN: '이전 확정 장부의 기초가액',
}

const coverageStatusLabel: Record<string, string> = {
  COMPLETE: '전체 기간 확인됨',
  PARTIAL: '일부 기간만 확인됨',
  UNKNOWN: '자료 범위 확인 필요',
}

const coverageAssuranceLabel: Record<string, string> = {
  CHAIN_VERIFIED: '온체인 기준 확인됨',
  DOCUMENT_METADATA_VERIFIED: '문서 기준 확인됨',
  USER_DECLARED: '제공한 자료 기준',
  UNKNOWN: '검증 수준 확인 필요',
}

const sourceSystemLabel = (systemName: string | null, sourceKind: string) => {
  if (systemName === 'UPBIT' || sourceKind === 'UPBIT_FILE') return '업비트 거래내역'
  return '연결된 원본 자료'
}

const limitationCopy = (code: string) => limitationPresentation[code] ?? {
  title: '계산에 필요한 정보 확인이 필요합니다',
  description: '이 항목은 현재 계산을 확정하기 전에 추가 확인이 필요합니다.',
}

const basisReasonLabel: Record<string, string> = {
  NON_VASP_NO_BOOKS_OR_EVIDENCE: '장부·증빙을 확인할 수 없는 비가상자산사업자 거래',
  NTS_DESIGNATED_OTHER: '국세청 지정 사유',
}

const chartAtomicAmount = (value: TaxReportV2AmountModel) => {
  if (!value.hasAmount || value.amount === null || !/^\d+$/.test(value.amount)) {
    return null
  }
  return BigInt(value.amount)
}

function Amount({
  value,
  denomination,
  denominationAtomicDecimals,
}: {
  value: TaxReportV2AmountModel
  denomination: string
  denominationAtomicDecimals: number
}) {
  return (
    <strong data-certainty={value.status}>
      {amountLabel(value, denomination, denominationAtomicDecimals)}
    </strong>
  )
}

const accountLabel = (account: TaxReportV2AccountModel) =>
  account.displayName ?? ({
    VASP: '거래소 계정', EVM_WALLET: '개인 지갑',
  }[account.accountKind ?? ''] ?? '계정 정보 확인 필요')

const valuationMarketLabel = (valuation: TaxReportV2ValuationModel) =>
  valuation.marketStatus === 'NOT_APPLICABLE'
    ? '직접 평가 · 시장 코드 해당 없음'
    : valuation.market ?? '시장 정보 확인 필요'

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
  const allBound = sourceEvidence.length > 0 && sourceEvidence.every(
    (source) => source.sourceArtifactBindingStatus === 'BOUND',
  )
  return (
    <dl className="tax-report-v2__row-detail">
      <div><dt>거래 일시</dt><dd>{dateTimeLabel(occurredAt)}</dd></div>
      {account ? <div><dt>거래소·지갑</dt><dd>{accountLabel(account)}</dd></div> : null}
      {from && to ? <div><dt>이동 경로</dt><dd>{accountLabel(from)} → {accountLabel(to)}</dd></div> : null}
      {valuation ? <>
        <div><dt>적용 가격 시점</dt><dd>{valuation.effectiveAt ? dateTimeLabel(valuation.effectiveAt) : '가격 시점 확인 필요'}</dd></div>
        <div><dt>가격 산정 상태</dt><dd>{valuation.status === 'KNOWN' ? '가격 산정 근거 확인됨' : valuation.status === 'PARTIAL' ? '가격 산정 근거 일부 확인됨' : '가격 산정 근거 확인 필요'}</dd></div>
        <div><dt>가격 데이터</dt><dd>{[valuation.provider, valuationMarketLabel(valuation)].filter(Boolean).join(' · ')}</dd></div>
      </> : null}
      {financials.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}
      <div><dt>데이터 출처</dt><dd>{sourceEvidence.length === 0 ? '출처 확인 필요' : '원본 자료 연결'} · {allBound ? '확인됨' : '추가 확인 필요'}</dd></div>
      <div><dt>근거 자료</dt><dd><a href={`/api/v1/tax-reports/${encodeURIComponent(reportId)}/evidence`} target="_blank" rel="noreferrer">원본 근거 보기</a></dd></div>
      <div><dt>사용자 확인</dt><dd>{review.status === 'CLEAR' ? '추가 확인 없음' : '거래 확인이 필요합니다'}</dd></div>
    </dl>
  )
}

function EventRow({
  reportId,
  label,
  amount,
  quantityLabel,
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
  quantityLabel: string
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
        <small>{dateLabel(occurredAt)} · 수량 {quantityLabel}</small>
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
  assetPresentations = {},
  pointerVersion,
  isCurrent = false,
  generationState,
  filingStatus,
}: {
  report: TaxReportV2DetailModel
  assetPresentations?: ReportAssetPresentations
  pointerVersion?: TaxReportModel['pointerVersion']
  isCurrent?: boolean
  generationState?: 'ACTIVE' | 'REVIEW_REQUIRED'
  filingStatus?: TaxReportModel['filingStatus']
}) {
  const [activeTab, setActiveTab] = useState<V2Tab>('summary')
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false)
  const [pdfPreviewUrl, setPdfPreviewUrl] = useState<string | null>(null)
  const [pdfPreviewStatus, setPdfPreviewStatus] =
    useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const pdfPath =
    `/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`
  const pdfHref =
    `/api/v1${pdfPath}`
  const policy = report.methodology.policy
  const formatAmount = (value: TaxReportV2AmountModel) => amountLabel(
    value,
    report.denominationAssetId,
    report.denominationAtomicDecimals,
  )
  const displayAsset = (taxAssetId: string) =>
    assetPresentations[taxAssetId]?.symbol ?? taxAssetLabel(taxAssetId)
  const describeAsset = (taxAssetId: string) => {
    const presentation = assetPresentations[taxAssetId]
    return presentation?.metadata ?? '자산 정보 확인 필요'
  }
  const formatQuantity = (quantity: string, taxAssetId: string) => {
    const asset = assetPresentations[taxAssetId]
    if (asset?.decimals === undefined) return '수량 단위 확인 필요'
    return `${formatLedgerQuantity(quantity, asset.decimals)} ${asset.symbol}`
  }
  const rateLabel = ({ numerator, denominator }: { numerator: string; denominator: string }) => {
    const rate = Number(numerator) / Number(denominator) * 100
    if (!Number.isFinite(rate)) return '세율 확인 필요'
    return `${new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 4 }).format(rate)}%`
  }
  const effectiveFilingStatus = filingStatus ?? report.filingStatus
  const disposalCount =
    report.counts.disposals + report.counts.feeAssetDisposals
  const reviewableLimitations = report.limitations.filter(
    (item) => item.reviewId !== null && item.reviewRevisionId !== null,
  )
  const reviewItems = reviewableLimitations.slice(0, 3)
  const chartAssets = report.assetSummaries
    .map((asset) => ({ asset, amount: chartAtomicAmount(asset.grossProceeds) }))
    .filter((item): item is typeof item & { amount: bigint } => item.amount !== null)
    .sort((left, right) => left.amount === right.amount ? 0 : left.amount > right.amount ? -1 : 1)
    .slice(0, 6)
  const chartMaximum = chartAssets[0]?.amount ?? 0n
  const attestationEligible =
    isCurrent &&
    (generationState === 'ACTIVE' || generationState === 'REVIEW_REQUIRED')

  useEffect(() => {
    if (!pdfPreviewOpen) {
      setPdfPreviewUrl(null)
      setPdfPreviewStatus('idle')
      return
    }

    const controller = new AbortController()
    let objectUrl: string | null = null
    setPdfPreviewUrl(null)
    setPdfPreviewStatus('loading')

    void requestRaw(pdfPath, {
      signal: controller.signal,
      headers: { accept: 'application/pdf' },
    })
      .then((response) => {
        if (!response.headers.get('content-type')?.toLowerCase().startsWith(
          'application/pdf',
        )) {
          throw new Error('tax report PDF response has an invalid media type')
        }
        return response.blob()
      })
      .then((pdf) => {
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(pdf)
        setPdfPreviewUrl(objectUrl)
        setPdfPreviewStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return
        }
        setPdfPreviewStatus('error')
      })

    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [pdfPath, pdfPreviewOpen])

  return (
    <article className="tax-report-v2" aria-labelledby="tax-report-v2-title">
      <header className="tax-report-v2__header">
        <div>
          <h1 id="tax-report-v2-title">
            {report.taxYear} 가상자산 세금 리포트
          </h1>
          <p>
            {report.reportFinality === 'FINAL'
              ? '검증된 연간 데이터와 고정된 정책으로 계산한 최신 결과입니다'
              : '지금까지 등록된 데이터와 고정된 정책으로 계산한 최신 예상값입니다'}
          </p>
        </div>
        <div className="tax-report-v2__pdf-actions">
          <button type="button" onClick={() => setPdfPreviewOpen(true)}>PDF 미리보기</button>
          <a className="tax-report-v2__pdf" href={pdfHref} download>PDF 내려받기</a>
        </div>
      </header>

      <section className="tax-report-v2__status" aria-label="리포트 상태">
        <span className="tax-report-v2__status-context">
          귀속연도 {report.taxYear}
        </span>
        <i aria-hidden="true" />
        <span className="tax-report-v2__status-time">
          최신 반영 <time dateTime={report.issuedAt}>{dateTimeLabel(report.issuedAt)}</time>
        </span>
        <button
          type="button"
          className="tax-report-v2__status-coverage"
          onClick={() => setActiveTab('basis')}
        >
          <span>반영 기간</span>
          <strong>{dateLabel(report.dataCoverage.from)} ~ {dateLabel(report.dataCoverage.through)}</strong>
        </button>
        <div className="tax-report-v2__meta">
          <span data-tone={report.reportFinality === 'FINAL' ? 'success' : 'warning'}>
            {statusLabel[report.reportFinality] ?? '상태 확인 필요'}
          </span>
          <span data-tone={effectiveFilingStatus === 'READY' ? 'success' : 'danger'}>
            {effectiveFilingStatus === 'READY' ? '신고 준비 완료' : '확인 필요'}
          </span>
          <span data-tone="neutral">
            {statusLabel[policy.applicationMode] ?? '적용 기준 확인 필요'}
          </span>
        </div>
        <div className="tax-report-v2__status-spacer" />
      </section>

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
        <section className="tax-report-v2__panel tax-report-v2__overview" role="tabpanel" id="tax-report-v2-panel-summary" aria-labelledby="tax-report-v2-tab-summary">
          <header className="sr-only">
            <div>
              <span>연간 세금 요약</span>
              <h3>세금 계산 결과</h3>
            </div>
            <p>현재 연결된 데이터가 반영된 최신 계산 결과입니다.</p>
          </header>
          <div className="tax-report-v2__kpis">
            <article>
              <span>총 처분가액</span>
              <Amount value={report.summary.grossProceeds} denomination={report.denominationAssetId} denominationAtomicDecimals={report.denominationAtomicDecimals} />
              <small>확인된 처분 {disposalCount}건</small>
            </article>
            <article>
              <span>처분 취득가액</span>
              <Amount value={report.summary.disposedBasis} denomination={report.denominationAssetId} denominationAtomicDecimals={report.denominationAtomicDecimals} />
              <small>연간 총평균 원가 배분</small>
            </article>
            <article>
              <span>연간 손익</span>
              <Amount value={report.summary.disposalGainLoss} denomination={report.denominationAssetId} denominationAtomicDecimals={report.denominationAtomicDecimals} />
              <small>수수료·필요경비 반영</small>
            </article>
            <article>
              <span>예상 총세액</span>
              <Amount value={report.summary.totalTax} denomination={report.denominationAssetId} denominationAtomicDecimals={report.denominationAtomicDecimals} />
              <small>{statusLabel[report.taxOutcome] ?? '세액 상태 확인 필요'}</small>
            </article>
          </div>
          <div className="tax-report-v2__overview-grid">
            <section className="tax-report-v2__asset-summary">
              <header>
                <h4>자산별 손익</h4>
                <button type="button" onClick={() => setActiveTab('assets')}>
                  행을 눌러 계산 근거 확인
                </button>
              </header>
              <div className="tax-report-v2__asset-table-wrap">
                <table aria-label="자산별 손익 요약">
                  <thead>
                    <tr>
                      <th scope="col">자산</th>
                      <th scope="col">처분가액</th>
                      <th scope="col">취득가액·비용</th>
                      <th scope="col">손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.assetSummaries.length === 0 ? (
                      <tr><td colSpan={4}>표시할 자산이 없습니다.</td></tr>
                    ) : report.assetSummaries.slice(0, 4).map((asset) => (
                      <tr key={asset.taxAssetId}>
                        <th scope="row">
                          <button type="button" onClick={() => setActiveTab('assets')}>
                            <span
                              className="tax-report-v2__asset-label"
                              title={describeAsset(asset.taxAssetId)}
                            >
                              {displayAsset(asset.taxAssetId)}
                            </span>
                          </button>
                        </th>
                        <td>{formatAmount(asset.grossProceeds)}</td>
                        <td>
                          {formatAmount(asset.disposedBasis)}
                          <small>필요경비 {formatAmount(asset.deductibleExpense)}</small>
                        </td>
                        <td>{formatAmount(asset.gainLoss)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="tax-report-v2__review-card" data-empty={reviewItems.length === 0 ? 'true' : undefined}>
              <span>계산 전 확인</span>
              <h4>
                {reviewItems.length > 0
                  ? `${reviewableLimitations.length}건의 거래를 확인해 주세요`
                  : '직접 검토할 거래가 없습니다'}
              </h4>
              <p>
                {reviewItems.length > 0
                  ? '장부 작업에 연결된 미확인 거래입니다. 처분 손익의 미확정 행 수와는 다릅니다.'
                  : `남은 제한 ${report.limitations.length}건은 데이터 범위·취득원가·정책 상태이며 거래 검토 건수와 다릅니다.`}
              </p>
              <div>
                {reviewItems.length === 0 ? (
                  <p>장부 작업에서 추가로 처리할 항목은 없습니다.</p>
                ) : reviewItems.map((item, index) => (
                  <AppLink
                    href="/ledger?view=review"
                    key={`${item.code}-${item.movementId ?? index}`}
                  >
                    <span>{limitationCopy(item.code).title}</span>
                    <small>{limitationCopy(item.code).description}</small>
                  </AppLink>
                ))}
              </div>
              <AppLink className="tax-report-v2__review-link" href="/ledger?view=review">
                {reviewItems.length > 0 ? `${reviewableLimitations.length}건 검토하기` : '제한 사유 확인하기'} →
              </AppLink>
            </section>
          </div>
          <section className="tax-report-v2__asset-chart" aria-labelledby="tax-report-v2-asset-chart-title">
            <header>
              <div>
                <span>자산별 처분 규모</span>
                <h4 id="tax-report-v2-asset-chart-title">현재 장부의 처분가액 비교</h4>
              </div>
              <small>확인된 처분가액 기준 · 최대 6개 자산</small>
            </header>
            {chartAssets.length === 0 ? (
              <p>비교할 수 있는 처분가액이 아직 없습니다.</p>
            ) : (
              <div className="tax-report-v2__asset-chart-rows">
                {chartAssets.map(({ asset, amount }) => {
                  const width = chartMaximum === 0n
                    ? 0
                    : Number((amount * 10_000n) / chartMaximum) / 100
                  return (
                    <div key={asset.taxAssetId}>
                      <strong title={describeAsset(asset.taxAssetId)}>{displayAsset(asset.taxAssetId)}</strong>
                      <span><i style={{ width: `${width}%` }} /></span>
                      <small>{formatAmount(asset.grossProceeds)}</small>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </section>
      ) : null}

      {activeTab === 'assets' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-assets" aria-labelledby="tax-report-v2-tab-assets">
          <header>
            <div><span>자산별 계산</span><h3>자산별 연간 총평균 장부</h3></div>
            <p>{report.assetSummaries.length}개 자산</p>
          </header>
          {report.assetSummaries.length === 0 ? <p className="tax-report-v2__empty">표시할 자산이 없습니다.</p> : (
            <div className="tax-report-v2__asset-list">
              {report.assetSummaries.map((asset) => (
                <article key={asset.taxAssetId}>
                  <header>
                    <div>
                      <h4 title={describeAsset(asset.taxAssetId)}>{displayAsset(asset.taxAssetId)}</h4>
                      <small>{assetPresentations[asset.taxAssetId]?.metadata ?? taxAssetLabel(asset.taxAssetId)}</small>
                    </div>
                    <span>{statusLabel[asset.basisMode] ?? '원가 기준 확인 필요'}</span>
                  </header>
                  <div className="tax-report-v2__average">
                    <div><span>원가 계산 방식</span><strong>{asset.annualAverage.status === 'NOT_APPLICABLE' ? '50% 필요경비 특례 적용' : '연간 총평균법 적용'}</strong></div>
                    <div><span>계산 기준</span><strong>{asset.annualAverage.status === 'NOT_APPLICABLE' ? '처분가액의 50%를 필요경비로 반영' : '연간 취득 내역을 합산해 처분 원가 계산'}</strong></div>
                  </div>
                  <dl>
                    <div><dt>기초수량 · 기초가액</dt><dd>{formatQuantity(asset.openingQuantity, asset.taxAssetId)} · {formatAmount(asset.openingBasis)}</dd></div>
                    <div><dt>기초가액 적용 근거</dt><dd>{asset.openingBasisProvenance.status === 'NOT_APPLICABLE' ? '해당 없음' : openingBasisLabel[asset.openingBasisProvenance.basisRule ?? ''] ?? '기초가액 근거 확인 필요'}</dd></div>
                    {asset.openingBasisProvenance.actualAcquisitionAmount !== null ? <div><dt>기초 실제취득가</dt><dd>{formatAmount({ status: 'KNOWN', hasAmount: true, amount: asset.openingBasisProvenance.actualAcquisitionAmount })}</dd></div> : null}
                    {asset.openingBasisProvenance.marketValueAt2026End !== null ? <div><dt>2026년 말 시가</dt><dd>{formatAmount({ status: 'KNOWN', hasAmount: true, amount: asset.openingBasisProvenance.marketValueAt2026End })}</dd></div> : null}
                    {asset.openingBasisProvenance.sourceRunId !== null ? <div><dt>이전 계산 기준</dt><dd>이전 확정 장부의 기초가액을 사용</dd></div> : null}
                    {asset.basisApplicationReasonCode !== null ? <div><dt>50% 특례 적용 사유</dt><dd>{basisReasonLabel[asset.basisApplicationReasonCode] ?? '특례 적용 사유 확인 필요'}</dd></div> : null}
                    {asset.ntsDesignationId !== null || asset.ntsDesignationPolicyVersion !== null ? <div><dt>특례 적용 근거</dt><dd>국세청 지정 기준에 따라 적용</dd></div> : null}
                    {asset.basisEvidenceDigest !== null ? <div><dt>특례 근거 자료</dt><dd>원본 근거 자료에 연결됨</dd></div> : null}
                    <div><dt>연간 취득수량 · 취득가액</dt><dd>{formatQuantity(asset.acquiredQuantity, asset.taxAssetId)} · {formatAmount(asset.acquisitionCost)}</dd></div>
                    <div><dt>처분수량 · 처분가액</dt><dd>{formatQuantity(asset.disposedQuantity, asset.taxAssetId)} · {formatAmount(asset.grossProceeds)}</dd></div>
                    <div><dt>처분 취득가액</dt><dd>{formatAmount(asset.disposedBasis)}</dd></div>
                    <div><dt>수수료·필요경비</dt><dd>{formatAmount(asset.deductibleExpense)}</dd></div>
                    <div><dt>자산별 손익</dt><dd>{formatAmount(asset.gainLoss)}</dd></div>
                    <div><dt>기말수량 · 기말가액</dt><dd>{formatQuantity(asset.endingQuantity, asset.taxAssetId)} · {formatAmount(asset.endingCost)}</dd></div>
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
            <div><span>거래별 계산 내역</span><h3>소득·취득·처분 내역</h3></div>
            <p>수수료 자산 처분은 일반 처분과 분리합니다.</p>
          </header>
          <div className="tax-report-v2__event-grid">
            <section>
              <h4>대여·기타 소득 <span>{report.incomeRows.length}</span></h4>
              {report.incomeRows.length === 0 ? <p>해당 내역이 없습니다.</p> : report.incomeRows.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'} · ${displayAsset(row.taxAssetId)}`}
                  amount={formatAmount(row.income)}
                  quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review} />
              ))}
            </section>
            <section>
              <h4>보상자산 취득 <span>{report.acquisitions.length}</span></h4>
              {report.acquisitions.length === 0 ? <p>해당 내역이 없습니다.</p> : report.acquisitions.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'} · ${displayAsset(row.taxAssetId)}`}
                  amount={formatAmount(row.acquisitionCost)}
                  quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[
                    { label: '취득 대가', value: formatAmount(row.consideration) },
                    { label: '취득 부대비용', value: formatAmount(row.acquisitionAncillaryExpense) },
                    { label: '총 취득가액', value: formatAmount(row.acquisitionCost) },
                    ...(row.incomePolicyMapping === null ? [] : [
                      { label: '취득 분류', value: incomePolicySubtypeLabel[row.incomePolicyMapping.eventSubtype] ?? '보상·기타 취득' },
                      { label: '처리 기준', value: '기타 취득으로 반영' },
                      { label: '근거 자료', value: '원본 근거 자료에 연결됨' },
                    ]),
                  ]} />
              ))}
            </section>
            <section>
              <h4>일반 처분 <span>{report.disposals.length}</span></h4>
              {report.disposals.length === 0 ? <p>해당 내역이 없습니다.</p> : report.disposals.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'} · ${displayAsset(row.taxAssetId)} · ${statusLabel[row.basisMode] ?? '원가 기준 확인 필요'}`}
                  amount={formatAmount(row.gainLoss)}
                  quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[
                    { label: '총 처분가액', value: formatAmount(row.grossProceeds) },
                    { label: '취득원가', value: formatAmount(row.basis) },
                    { label: '필요경비', value: formatAmount(row.ancillaryExpense) },
                    { label: '원천 실제 발생비용', value: formatAmount(row.incurredExpense) },
                    { label: '처분 손익', value: formatAmount(row.gainLoss) },
                    ...(row.basisEvidenceDigest === null ? [] : [{
                      label: '50% 특례 근거', value: '원본 근거 자료에 연결됨',
                    }]),
                  ]} />
              ))}
            </section>
            <section>
              <h4>수수료 자산 별도 처분 <span>{report.feeAssetDisposals.length}</span></h4>
              {report.feeAssetDisposals.length === 0 ? <p>해당 내역이 없습니다.</p> : report.feeAssetDisposals.map((row) => (
                <EventRow key={row.movementId}
                  reportId={report.reportId}
                  label={`${displayAsset(row.taxAssetId)} · ${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'}`}
                  amount={formatAmount(row.gainLoss)}
                  quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  account={row.account} valuation={row.valuation}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[
                    { label: '수수료 자산 처분가액', value: formatAmount(row.grossProceeds) },
                    { label: '수수료 자산 취득원가', value: formatAmount(row.basis) },
                    { label: '처분 손익', value: formatAmount(row.gainLoss) },
                    ...(row.basisEvidenceDigest === null ? [] : [{
                      label: '50% 특례 근거', value: '원본 근거 자료에 연결됨',
                    }]),
                  ]} />
              ))}
            </section>
            <section>
              <h4>원가 이어받기 이체 <span>{report.transfers.length}</span></h4>
              {report.transfers.length === 0 ? <p>해당 내역이 없습니다.</p> : report.transfers.map((row) => (
                <EventRow key={row.movementId} reportId={report.reportId}
                  label={`${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'} · ${displayAsset(row.taxAssetId)}`}
                  amount={formatAmount(row.basis)}
                  quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  from={row.from} to={row.to}
                  sourceEvidence={row.sourceEvidence} review={row.review}
                  financials={[{ label: '이어받은 취득원가', value: formatAmount(row.basis) }]} />
              ))}
            </section>
            <section>
              <h4>비과세 자기이체 <span>{report.nonTaxableTransfers.length}</span></h4>
              {report.nonTaxableTransfers.length === 0 ? <p>해당 내역이 없습니다.</p> : report.nonTaxableTransfers.map((row) => (
                <EventRow key={row.movementId} reportId={report.reportId}
                  label={`${transactionLabel[row.transactionType] ?? '거래 유형 확인 필요'} · ${displayAsset(row.taxAssetId)}`}
                  amount="과세 제외" quantityLabel={formatQuantity(row.quantity, row.taxAssetId)} occurredAt={row.occurredAt}
                  from={row.from} to={row.to}
                  sourceEvidence={row.sourceEvidence} review={row.review} />
              ))}
            </section>
            <section>
              <h4>처분 제외 교환 <span>{report.excludedConversions.length}</span></h4>
              {report.excludedConversions.length === 0 ? <p>해당 내역이 없습니다.</p> : report.excludedConversions.map((row) => (
                <div className="tax-report-v2__excluded" key={row.relationId}>
                  <strong title={describeAsset(row.taxAssetId)}>{displayAsset(row.taxAssetId)}</strong>
                  <span>전환 수량 {formatQuantity(row.fromQuantity, row.taxAssetId)} → {formatQuantity(row.toQuantity, row.taxAssetId)}</span>
                </div>
              ))}
            </section>
          </div>
        </section>
      ) : null}

      {activeTab === 'basis' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-basis" aria-labelledby="tax-report-v2-tab-basis">
          <header>
            <div><span>계산 기준과 원본 근거</span><h3>계산 규칙과 법적 근거</h3></div>
            <p>현재 장부에 적용된 계산 기준과 확인 가능한 근거 자료입니다.</p>
          </header>
          <div className="tax-report-v2__basis-grid">
            <section>
              <h4>계산 규칙</h4>
              <dl>
                <div><dt>계산 단위</dt><dd>자산별·연도별 합산</dd></div>
                <div><dt>원가 방식</dt><dd>연간 총평균법</dd></div>
                <div><dt>기본공제 / 실제 적용</dt><dd>{formatAmount({ status: 'KNOWN', hasAmount: true, amount: report.summary.calculationRule.basicDeductionAmount })} / {report.summary.calculationRule.deductionUsedAmount === null ? '미확정' : formatAmount({ status: 'KNOWN', hasAmount: true, amount: report.summary.calculationRule.deductionUsedAmount })}</dd></div>
                <div><dt>국세율</dt><dd>{rateLabel(report.summary.calculationRule.nationalRate)}</dd></div>
                <div><dt>지방세율</dt><dd>{rateLabel(report.summary.calculationRule.localRate)}</dd></div>
                <div><dt>세액 반올림</dt><dd>{roundingLabel[report.summary.calculationRule.taxRounding] ?? '반올림 기준 확인 필요'}</dd></div>
                <div>
                  <dt>신고용 반올림 기준</dt>
                  <dd>
                    {policy.roundingProfileStatus === 'APPROVED'
                      ? '승인됨'
                      : '승인 전 · 현재 세액은 추정치'}
                  </dd>
                </div>
                <div><dt>원가 배분 반올림</dt><dd>{roundingLabel[report.summary.calculationRule.basisAllocationRounding] ?? '반올림 기준 확인 필요'}</dd></div>
              </dl>
            </section>
            <section>
              <h4>적용 세무 계산 기준</h4>
              <p>{dateLabel(policy.effectiveFrom)} ~ {dateLabel(policy.effectiveThrough)} 적용</p>
              <ul className="tax-report-v2__legal">
                {policy.legalReferences.map((reference) => (
                  <li key={`${reference.law}-${reference.article}-${reference.paragraphs.join('-')}`}>
                    <strong>{reference.law} {reference.article}{reference.paragraphs.length > 0 ? ` ${reference.paragraphs.join(', ')}` : ''}</strong>
                    <span>{reference.purpose}</span>
                    {reference.sourceLocators.map((locator, locatorIndex) => (
                      <a
                        key={locator}
                        href={locator}
                        target="_blank"
                        rel="noreferrer"
                      >
                        국가법령정보센터 원문{reference.sourceLocators.length > 1 ? ` ${locatorIndex + 1}` : ''}
                      </a>
                    ))}
                    {reference.sourceCheckedAt ? (
                      <small>근거 확인일: {dateLabel(reference.sourceCheckedAt)}</small>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section className="tax-report-v2__sources">
            <h4>실제 계산 데이터 범위</h4>
            {report.sourceCoverage.map((source) => (
              <div key={source.sourceArtifactId}>
                <strong>{sourceSystemLabel(source.systemName, source.sourceKind)}</strong>
                <span>{coverageStatusLabel[source.status] ?? '자료 범위 확인 필요'} · {coverageAssuranceLabel[source.assurance] ?? '검증 수준 확인 필요'}</span>
                <small>포함: {source.coveredIntervals.map(intervalLabel).join(', ') || '검증된 구간 없음'}</small>
                <small>누락: {source.uncoveredIntervals.map(intervalLabel).join(', ') || '없음'}</small>
                <a href={`/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/evidence`} target="_blank" rel="noreferrer">원본 근거 보기</a>
              </div>
            ))}
          </section>
          {report.limitations.length > 0 ? (
            <section className="tax-report-v2__limitations">
              <h4>검토할 항목</h4>
              {report.limitations.map((item, index) => (
                <div key={`${item.code}-${item.movementId ?? index}`}>
                  <strong>{limitationCopy(item.code).title}</strong><span>{limitationCopy(item.code).description}</span>
                </div>
              ))}
            </section>
          ) : null}
        </section>
      ) : null}
      {activeTab === 'verification' ? (
        <section className="tax-report-v2__panel" role="tabpanel" id="tax-report-v2-panel-verification" aria-labelledby="tax-report-v2-tab-verification">
          <header>
            <div><span>변경 불가 증명</span><h3>현재 장부 EAS 증빙</h3></div>
            <p>필요한 시점에 현재 장부와 원본 근거의 정확한 상태를 블록체인에 기록합니다. 이 기록은 세무 확정이나 신고 승인을 뜻하지 않습니다.</p>
          </header>
          <ReportAttestationControl
            reportId={report.reportId}
            reportModelDigest={report.reportModelDigest}
            pointerVersion={pointerVersion ?? 1}
            eligible={attestationEligible}
          />
        </section>
      ) : null}
      {pdfPreviewOpen ? (
        <div className="tax-report-v2__pdf-dialog" role="dialog" aria-modal="true" aria-labelledby="tax-report-v2-pdf-title">
          <div>
            <header>
              <h3 id="tax-report-v2-pdf-title">PDF 미리보기</h3>
              <button type="button" onClick={() => setPdfPreviewOpen(false)} aria-label="PDF 미리보기 닫기">닫기</button>
            </header>
            {pdfPreviewStatus === 'loading' ? (
              <p className="tax-report-v2__pdf-state" role="status">
                PDF를 안전하게 불러오는 중입니다.
              </p>
            ) : null}
            {pdfPreviewStatus === 'error' ? (
              <p className="tax-report-v2__pdf-state is-error" role="alert">
                PDF 미리보기를 불러오지 못했습니다. 내려받기로 다시 확인해 주세요.
              </p>
            ) : null}
            {pdfPreviewStatus === 'ready' && pdfPreviewUrl ? (
              <iframe
                title={`${report.taxYear}년 세무 장부 PDF`}
                src={pdfPreviewUrl}
              />
            ) : null}
            <a className="tax-report-v2__pdf" href={pdfHref} download>PDF 내려받기</a>
          </div>
        </div>
      ) : null}
    </article>
  )
}
