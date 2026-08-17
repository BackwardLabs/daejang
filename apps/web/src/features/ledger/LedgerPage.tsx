import { Fragment, type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppSidebar } from '../../components/AppSidebar.tsx'
import { AppLink } from '../../components/AppLink.tsx'
import { ApiClientError } from '../../api/client.ts'
import {
  loadDashboard,
  loadAllLedger,
  loadLedgerEventLots,
  loadReview,
  loadReviews,
  resolveReview,
  type DashboardModel,
  type LedgerEventModel,
  type LedgerLotLineageModel,
  type LedgerLotLinkModel,
  type LedgerPostingModel,
  type ReviewDetailModel,
  type ReviewModel,
  type ReviewObservationModel,
} from '../../api/productApi.ts'
import {
  loadAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import {
  describeLedgerAction,
  describeLedgerSource,
  describeLotBasisStatus,
  describePostingDirection,
  describePostingRole,
  describeReviewReason,
  describeTransferEndpoint,
  formatCanonicalQuantity,
  formatLedgerMoney,
  formatLedgerQuantity,
  formatLedgerUnitPrice,
  formatUserFacingAssetSymbol,
  parseLedgerAsset,
} from './ledgerPresentation.ts'
import { projectLedgerTransactions } from './ledgerProjection.ts'
import './ledger.css'

const statusLabel = (value: string) => value === 'RESOLVED' ? '완료' : value === 'PARTIAL' ? '일부 확인' : '검토 필요'
const feeRoles = new Set(['FEE', 'GAS'])
const sourceKindLabels = { CEX: '거래소', WALLET: '개인지갑', UNKNOWN: '출처 미확인' } as const
const ledgerRowsPerPage = 20

type LedgerSourceFilter = 'ALL' | 'CEX' | 'WALLET'

const initialLedgerView = (): 'ledger' | 'review' =>
  new URLSearchParams(window.location.search).get('view') === 'review'
    ? 'review'
    : 'ledger'

const matchesLedgerSourceFilter = (
  event: LedgerEventModel,
  sourceFilter: LedgerSourceFilter,
) => sourceFilter === 'ALL' || describeLedgerSource(event.postings).kind === sourceFilter

const formatMetricCount = (value: number | string | undefined) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return `${value}건`
  if (typeof value === 'string' && /^\d+$/.test(value)) return `${value}건`
  return '—'
}

const describeProjectedAction = (event: LedgerEventModel) => {
  if ((event.projectedActions?.length ?? 0) > 1) {
    return {
      label: '복합 실행',
      description: `확정 액션 ${event.projectedActions!.length}개`,
    }
  }
  return describeLedgerAction(event.eventType, event.flowShape, event.postings, event.subtype)
}

const formatLedgerDateTime = (value: string) => new Date(value).toLocaleString('ko-KR', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
})

const describeReviewResolution = (review: ReviewDetailModel) =>
  review.options.find((option) => option.code === review.resolutionCode)?.label ??
  '선택한 처리 방식'

export const formatReviewQuantity = formatCanonicalQuantity

const reviewKindLabels: Record<string, string> = {
  TRADE: '거래',
  SWAP: '교환',
  TRANSFER: '자산 이동',
  DEPOSIT: '입금',
  WITHDRAWAL: '출금',
  FIAT_DEPOSIT: '원화 입금',
  FIAT_WITHDRAWAL: '원화 출금',
  REWARD: '보상',
  FEE: '수수료',
}

const reviewChainLabels: Record<string, string> = {
  '1': 'Ethereum',
  '10': 'Optimism',
  '137': 'Polygon',
  '8453': 'Base',
  '42161': 'Arbitrum',
}

const formatGroupedCanonicalQuantity = (value: string) => value.replace(
  /^(-?)(\d+)(\.\d+)?(.*)$/,
  (_match, sign: string, integer: string, fraction = '', suffix = '') =>
    `${sign}${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction}${suffix}`,
)

export const formatReviewDisplayQuantity = (observation: ReviewObservationModel) => {
  const quantity = formatReviewQuantity(
    observation.quantity,
    observation.hasAssetDecimals ? observation.assetDecimals : undefined,
  )
  const displayQuantity = observation.assetSymbol?.toUpperCase() === 'KRW'
    ? quantity.replace(' (단위 확인 필요)', '')
    : quantity
  return `${formatGroupedCanonicalQuantity(displayQuantity)}${observation.assetSymbol ? ` ${formatUserFacingAssetSymbol(observation.assetSymbol)}` : ''}`
}

const formatReviewSource = (observation: ReviewObservationModel) => {
  const domain = observation.domain.toUpperCase()
  const candidates = [
    observation.accountLabel,
    observation.accountLocator,
    observation.assetLocator,
    observation.nativeId,
  ].filter(Boolean)
  const joined = candidates.join(' ')
  const venueMatch = joined.match(/(?:cex:\/\/|cex-document-asset:)([^/:\s]+)/i)
  const chainId = observation.accountChainId.replace(/^eip155:/i, '')
  if (domain === 'CEX' || venueMatch) {
    const venue = venueMatch?.[1]
    return {
      label: venue ? `${venue.slice(0, 1).toUpperCase()}${venue.slice(1).toLowerCase()}` : observation.accountLabel || '거래소',
      type: '거래소',
      account: observation.accountLabel || observation.accountLocator || '거래소 계정',
    }
  }
  if (domain === 'EVM' || chainId || /^0x/i.test(observation.accountLocator)) {
    const network = reviewChainLabels[chainId] ?? (chainId ? `EVM ${chainId}` : 'EVM')
    return {
      label: `${network} 지갑`,
      type: 'EVM',
      account: observation.accountLabel || observation.accountLocator || 'EVM 지갑',
    }
  }
  return {
    label: observation.accountLabel || '연결 출처 확인 필요',
    type: domain || '출처 미확인',
    account: observation.accountLocator || '계정 정보 없음',
  }
}

const formatReviewKind = (observation: ReviewObservationModel) =>
  reviewKindLabels[observation.kind.toUpperCase()] ?? '거래 유형 확인'

const shortenTechnicalValue = (value: string, head = 10, tail = 8) => {
  if (value.length <= head + tail + 3) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

type ReviewCardPresentation = {
  title: string
  sourceType: string
  amount?: string
  occurredAt?: string
}

type ReviewPreviewStatus = 'idle' | 'loading' | 'ready' | 'error'

const presentReviewCard = (
  detail: ReviewDetailModel | undefined,
  event: LedgerEventModel | undefined,
): ReviewCardPresentation => {
  const observation = detail?.observations[0]
  if (observation) {
    const source = formatReviewSource(observation)
    return {
      title: `${source.label} · ${formatReviewKind(observation)}`,
      sourceType: source.type,
      amount: formatReviewDisplayQuantity(observation),
      occurredAt: event?.effectiveAt ?? observation.occurredAt,
    }
  }
  if (event) {
    const source = describeLedgerSource(event.postings)
    const action = describeProjectedAction(event)
    const material = event.postings.find((posting) => !feeRoles.has(posting.role))
    const asset = material ? parseLedgerAsset(
      material.assetId,
      material.assetSymbol,
      material.hasAssetDecimals ? material.assetDecimals : undefined,
      material.assetVenue,
    ) : undefined
    return {
      title: `${source.label} · ${action.label}`,
      sourceType: sourceKindLabels[source.kind],
      amount: material && asset
        ? `${formatLedgerQuantity(material.quantity, asset.decimals)}${asset.decimals !== undefined ? ` ${formatUserFacingAssetSymbol(asset.symbol)}` : ''}`
        : undefined,
      occurredAt: event.effectiveAt,
    }
  }
  return {
    title: '원본 거래를 확인하지 못했습니다',
    sourceType: '원본 조회 실패',
  }
}

function ReviewListCard({
  review,
  detail,
  event,
  selected,
  occurredAt,
  previewStatus,
  onSelect,
  onRequestDetail,
}: {
  review: ReviewModel
  detail?: ReviewDetailModel
  event?: LedgerEventModel
  selected: boolean
  occurredAt?: string
  previewStatus: ReviewPreviewStatus
  onSelect: (reviewId: string) => void
  onRequestDetail: (reviewId: string) => void
}) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const presentation = presentReviewCard(detail, event)
  const isPreviewPending = !detail && !event && previewStatus !== 'error'
  const reviewStateLabel = review.reasonCodes[0]
    ? describeReviewReason(review.reasonCodes[0])
    : statusLabel(review.status)

  useEffect(() => {
    if (detail || event || typeof IntersectionObserver === 'undefined' || !buttonRef.current) return
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      onRequestDetail(review.id)
      observer.disconnect()
    }, { rootMargin: '160px 0px' })
    observer.observe(buttonRef.current)
    return () => observer.disconnect()
  }, [detail, event, onRequestDetail, review.id])

  const displayedAt = presentation.occurredAt ?? occurredAt
  return <button
    ref={buttonRef}
    type="button"
    className={[selected ? 'is-selected' : '', isPreviewPending ? 'is-loading' : ''].filter(Boolean).join(' ') || undefined}
    aria-busy={isPreviewPending}
    aria-label={isPreviewPending ? `거래 요약을 불러오는 중 · ${reviewStateLabel}` : undefined}
    onClick={() => onSelect(review.id)}
    onFocus={() => onRequestDetail(review.id)}
    onMouseEnter={() => onRequestDetail(review.id)}
  >
    {isPreviewPending ? <>
      <span className="ledger-review-card__body ledger-review-card__skeleton" aria-hidden="true">
        <i /><i /><i />
      </span>
      <span className="ledger-review-card__state">
        {review.reasonCodes[0] ? <small>{reviewStateLabel}</small> : null}
        <b>{statusLabel(review.status)}</b>
      </span>
    </> : <>
      <span className="ledger-review-card__body">
        <small className="ledger-review-card__source">{presentation.sourceType}</small>
        <strong>{presentation.title}</strong>
        <small>{[presentation.amount, displayedAt ? formatLedgerDateTime(displayedAt) : undefined].filter(Boolean).join(' · ') || '거래 시각을 확인하지 못했습니다'}</small>
      </span>
      <span className="ledger-review-card__state">
        {review.reasonCodes[0] ? <small>{reviewStateLabel}</small> : null}
        <b>{statusLabel(review.status)}</b>
      </span>
    </>}
  </button>
}

function ReviewObservationEvidence({ observation }: { observation: ReviewObservationModel }) {
  const source = formatReviewSource(observation)
  const amount = formatReviewDisplayQuantity(observation)
  const occurredAt = observation.occurredAt
    ? formatLedgerDateTime(observation.occurredAt)
    : '시간 정보 없음'
  const account = shortenTechnicalValue(source.account)
  const transactionId = observation.nativeId || observation.originLinkId || observation.observationId

  return <li className="ledger-review-evidence__item">
    <div className="ledger-review-evidence__summary">
      <span>
        <small>{source.type}</small>
        <strong>{source.label} · {formatReviewKind(observation)}</strong>
      </span>
      <b>{amount}</b>
    </div>
    <dl className="ledger-review-evidence__readable">
      <div><dt>거래 시각</dt><dd>{occurredAt}</dd></div>
      <div><dt>계정·지갑</dt><dd title={source.account}>{account}</dd></div>
      <div><dt>자산</dt><dd>{formatUserFacingAssetSymbol(observation.assetSymbol)}</dd></div>
      <div><dt>거래 유형</dt><dd>{formatReviewKind(observation)}</dd></div>
    </dl>
    <details className="ledger-review-technical">
      <summary>상세보기</summary>
      <dl>
        <div><dt>거래·원본 식별자</dt><dd>{transactionId}</dd></div>
        <div><dt>관찰 식별자</dt><dd>{observation.observationId}</dd></div>
        <div><dt>계정·지갑 원본값</dt><dd>{[observation.accountLabel, observation.accountLocator, observation.accountChainId].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
        <div><dt>자산 원본값</dt><dd>{[observation.assetSymbol, observation.assetLocator].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
        <div><dt>근거 유형 코드</dt><dd>{[observation.domain, observation.kind, observation.originKind].filter(Boolean).join(' · ') || '제공되지 않음'}</dd></div>
        <div><dt>원본 수량 값</dt><dd>{observation.quantity}</dd></div>
        {observation.originLinkId ? <div><dt>원본 연결 식별자</dt><dd>{observation.originLinkId}</dd></div> : null}
      </dl>
    </details>
  </li>
}

function ReviewTechnicalDetails({ review }: { review: ReviewDetailModel }) {
  return <details className="ledger-review-technical ledger-review-technical--review">
    <summary>검토 처리 정보 보기</summary>
    <dl>
      <div><dt>검토 식별자</dt><dd>{review.id}</dd></div>
      <div><dt>현재 변경본</dt><dd>{review.revisionNumber}번 · {review.revisionId}</dd></div>
      <div><dt>연결 버전</dt><dd>{String(review.pointerVersion)}</dd></div>
      <div><dt>원본 사유 코드</dt><dd>{review.reasonCodes.join(' · ') || '없음'}</dd></div>
      <div><dt>입력 데이터 지문</dt><dd>{review.inputDigest}</dd></div>
    </dl>
  </details>
}

function ReviewSubmissionNotice({ resolution }: { resolution: string }) {
  return <section className="ledger-review-completion" role="status" aria-live="polite">
    <span className="ledger-review-completion__icon" aria-hidden="true">✓</span>
    <span>
      <strong>검토 응답 저장 완료 · 장부 반영 대기</strong>
      <small>‘{resolution}’ 응답을 저장했습니다</small>
    </span>
  </section>
}

const preTaxEffectiveDate = new Date('2027-01-01T00:00:00+09:00')

type LotStatus = 'idle' | 'loading' | 'ready' | 'error'

function LedgerTaxCostBasis({
  posting,
  postings,
  effectiveAt,
}: {
  posting: LedgerPostingModel
  postings: LedgerPostingModel[]
  effectiveAt: string
}) {
  if (posting.costBasis) {
    return formatLedgerMoney(posting.costBasis, posting.denomination, postings)
  }
  const asset = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  if (posting.direction !== 'IN' || posting.role !== 'PRINCIPAL' || asset.symbol === 'KRW') return '—'
  const isPreTaxHolding = new Date(effectiveAt) < preTaxEffectiveDate
  return <span className="ledger-posting-value ledger-posting-tax-basis">
    <strong>산정 대기</strong>
    <small>{isPreTaxHolding ? '2026.12.31 기준 적용 예정' : 'Lot 계산 후 확정'}</small>
  </span>
}

function LedgerPostingRow({
  posting,
  postings,
  effectiveAt,
}: {
  posting: LedgerPostingModel
  postings: LedgerPostingModel[]
  effectiveAt: string
}) {
  const asset = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  const role = describePostingRole(posting.role)
  const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
  const displaySymbol = formatUserFacingAssetSymbol(asset.symbol)
  return <tr>
    <td>
      <span className="ledger-posting-value">
        <strong>{displaySymbol}</strong>
        {asset.metadata ? <small>{asset.metadata}</small> : null}
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-direction" data-direction={posting.direction}>
        <strong>{describePostingDirection(posting.direction)}</strong>
        <small>{posting.direction === 'IN' ? '보유 수량 증가' : posting.direction === 'OUT' ? '보유 수량 감소' : '확인 필요'}</small>
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-quantity">
        <strong>{quantity}{asset.decimals !== undefined ? ` ${displaySymbol}` : ''}</strong>
      </span>
    </td>
    <td>
      <span className="ledger-posting-value ledger-posting-role">
        <strong>{role.label}</strong>
        <small>{role.description}</small>
      </span>
    </td>
    <td>{formatLedgerMoney(posting.fairValue, posting.denomination, postings)}</td>
    <td>{formatLedgerUnitPrice(posting, postings)}</td>
    <td><LedgerTaxCostBasis posting={posting} postings={postings} effectiveAt={effectiveAt} /></td>
  </tr>
}

// Lot 계보는 취득원가 확정과 다른 층이므로 세무 취득원가 칸과 섞지 않고,
// 저장된 allocation 행이 있을 때만 그 내용 그대로 보여 준다.
function LedgerLotLinks({
  posting,
  postings,
  links,
}: {
  posting: LedgerPostingModel
  postings: LedgerPostingModel[]
  links: LedgerLotLinkModel[]
}) {
  const asset = parseLedgerAsset(
    posting.assetId,
    posting.assetSymbol,
    posting.hasAssetDecimals ? posting.assetDecimals : undefined,
    posting.assetVenue,
  )
  const unit = asset.decimals !== undefined ? ` ${formatUserFacingAssetSymbol(asset.symbol)}` : ''
  const quantityOf = (value: string) => `${formatLedgerQuantity(value, asset.decimals)}${unit}`
  const basisOf = (link: LedgerLotLinkModel) => link.basisStatus === 'KNOWN' && link.basisAmount
    ? `취득원가 ${formatLedgerMoney(link.basisAmount, link.basisDenomination, postings)}`
    : describeLotBasisStatus(link.basisStatus)
  // 저장된 금액은 취득 Lot 전체의 원가다. 한 Lot이 여러 처분에 나뉘어 소진되므로
  // 소진분의 원가로 읽히면 합산 시 중복된다. 소진분 원가는 아직 산출되지 않는다.
  const lotBasisOf = (link: LedgerLotLinkModel) => link.basisStatus === 'KNOWN' && link.basisAmount
    ? `Lot 전체 ${basisOf(link)}`
    : describeLotBasisStatus(link.basisStatus)
  const acquisitions = links.filter((link) => link.kind === 'ACQUIRE')
  const disposals = links.filter((link) => link.kind === 'DISPOSE')
  const summary = [
    ...acquisitions.map((link) => `Lot 생성 · 잔여 ${quantityOf(link.remainingQuantity)}`),
    ...(disposals.length ? [`취득 ${disposals.length}건에서 소진`] : []),
  ].join(' · ')
  return <details className="ledger-lot">
    <summary>{summary}</summary>
    <ul>
      {acquisitions.map((link) => <li key={link.lotId}>
        <span>이 거래로 생긴 Lot</span>
        <strong>{quantityOf(link.quantity)}</strong>
        <small>잔여 {quantityOf(link.remainingQuantity)} · {basisOf(link)}</small>
      </li>)}
      {disposals.map((link) => <li key={`${link.lotId}:${link.sourceLegId}`}>
        <span>{link.sourceOccurredAt ? `${formatLedgerDateTime(link.sourceOccurredAt)} 취득분` : '취득 시각 미확인'}</span>
        <strong>{quantityOf(link.quantity)} 소진</strong>
        <small>취득 수량 {quantityOf(link.sourceQuantity)} · {lotBasisOf(link)}</small>
      </li>)}
    </ul>
  </details>
}

function LedgerMovementList({ postings }: { postings: LedgerPostingModel[] }) {
  if (!postings.length) return <span className="ledger-explorer__empty-value">—</span>
  return <span className="ledger-explorer__movements">
    {postings.map((posting) => {
      const asset = parseLedgerAsset(
        posting.assetId,
        posting.assetSymbol,
        posting.hasAssetDecimals ? posting.assetDecimals : undefined,
        posting.assetVenue,
      )
      const quantity = formatLedgerQuantity(posting.quantity, asset.decimals)
      const displaySymbol = formatUserFacingAssetSymbol(asset.symbol)
      return <span key={posting.legId} className="ledger-explorer__movement" data-direction={posting.direction}>
        <b>{describePostingDirection(posting.direction)}</b>
        <strong>{quantity}{asset.decimals !== undefined ? ` ${displaySymbol}` : ''}</strong>
        {asset.decimals === undefined ? <small>{displaySymbol}</small> : null}
      </span>
    })}
  </span>
}

function LedgerStatusBadges({ event }: { event: LedgerEventModel }) {
  const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
  const valued = material.filter((posting) => posting.fairValue || posting.costBasis)
  const ledgerState = event.postings.length
    ? event.resolution === 'RESOLVED' ? '장부 반영 완료' : '장부 일부 반영'
    : '장부 미반영'
  const valuationState = valued.length === material.length && material.length > 0
    ? '평가 완료'
    : valued.length > 0 ? '일부 평가' : '평가 대기'
  const label = event.resolution === 'RESOLVED'
    ? '처리 완료'
    : event.resolution === 'PARTIAL' ? '일부 확인' : '검토 필요'
  // 해석 상태와 검토 워크플로 상태는 다른 축이다. 검토를 이미 답했는데
  // 해석이 아직 PARTIAL 이면 '일부 확인 · 검토 완료' 로 함께 보여준다.
  const reviewBadge = event.resolution !== 'RESOLVED' && event.reviewState === 'RESOLVED'
    ? '검토 완료'
    : undefined
  return <span className="ledger-explorer__badges">
    <b
      className="is-primary"
      data-tone={event.resolution === 'RESOLVED' ? 'success' : 'warning'}
      title={`${ledgerState} · ${valuationState}`}
      aria-label={`${reviewBadge ? `${label} · ${reviewBadge}` : label}. ${ledgerState}. ${valuationState}`}
    >{reviewBadge ? `${label} · ${reviewBadge}` : label}</b>
  </span>
}

function LedgerLotNote({ status, lineage }: { status: LotStatus; lineage?: LedgerLotLineageModel }) {
  if (status === 'loading') return <p className="ledger-lot-note" role="status">Lot 계보를 불러오는 중입니다.</p>
  if (status === 'error') return <p className="ledger-lot-note" role="alert">Lot 계보를 불러오지 못했습니다. 장부 내용은 그대로 확인할 수 있습니다.</p>
  if (status !== 'ready') return null
  if (!lineage?.runId) return <p className="ledger-lot-note">이 계정에는 아직 Lot 계보가 산출되지 않았습니다.</p>
  if (!lineage.links.length) return <p className="ledger-lot-note">현재 Lot 실행에 이 거래로 연결된 취득·처분 Lot이 없습니다.</p>
  return null
}

function LedgerExplorerDetail({
  event,
  reviewNavigationStatus,
  knownReviewStatus,
  onOpenReview,
  lotStatus,
  lotLineage,
}: {
  event: LedgerEventModel
  reviewNavigationStatus: 'idle' | 'loading' | 'error' | 'resolved' | 'none'
  knownReviewStatus?: string
  onOpenReview: (eventId: string) => void
  lotStatus: LotStatus
  lotLineage?: LedgerLotLineageModel
}) {
  const source = describeLedgerSource(event.postings)
  const action = describeProjectedAction(event)
  const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
  const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
  const valued = material.filter((posting) => posting.fairValue || posting.costBasis)
  // 버튼은 정적 reviewRequired 플래그가 아니라 실제 검토 상태를 따른다.
  // 확정된 검토만 있으면 '검토 완료', 검토가 없다고 판명되면 안내만 남긴다.
  const reviewWorkflowState = event.reviewState || knownReviewStatus
  const reviewSettled = event.transferEndpoint?.reviewRequired === true &&
    ((reviewWorkflowState !== undefined && reviewWorkflowState !== '' && reviewWorkflowState !== 'OPEN') ||
      reviewNavigationStatus === 'resolved')
  const showReviewButton = event.transferEndpoint?.reviewRequired === true &&
    !reviewSettled && reviewNavigationStatus !== 'none'
  const transferEndpoint = event.eventType === 'TRANSFER'
    && !['FIAT_IN', 'FIAT_OUT'].includes(event.flowShape)
    && !['FIAT_DEPOSIT', 'FIAT_WITHDRAWAL'].includes(event.subtype ?? '')
    ? describeTransferEndpoint(event.postings, event.transferEndpoint)
    : undefined
  return <div className="ledger-explorer-detail">
    <div className="ledger-explorer-detail__summary">
      <section><span>입력 출처</span><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]}</small></section>
      <section><span>확인된 액션</span><strong>{action.label}</strong><small>{action.description}</small></section>
      <section><span>장부 반영</span><strong>{material.length}건</strong><small>자산 변동 · 수수료 {fees.length}건</small></section>
      <section><span>세무 처리</span><strong>{valued.length ? `${valued.length}건 평가` : '평가 대기'}</strong><small>취득 원가와 세금 결과로 연결</small></section>
    </div>

    {transferEndpoint ? <section className="ledger-explorer-endpoint" data-tone={transferEndpoint.tone}>
      <span>{transferEndpoint.label}</span>
      <div><strong>{transferEndpoint.title}</strong><small>{transferEndpoint.detail}</small></div>
      {reviewSettled ? <span className="ledger-explorer-endpoint__actions">
        <b>{transferEndpoint.status}</b>
        <b className="ledger-explorer-endpoint__resolved">검토 완료</b>
      </span> : showReviewButton ? <span className="ledger-explorer-endpoint__actions">
        <b>{transferEndpoint.status}</b>
        <button
          type="button"
          className="ledger-explorer-endpoint__review"
          disabled={reviewNavigationStatus === 'loading'}
          onClick={() => onOpenReview(event.eventId)}
        >
          {reviewNavigationStatus === 'loading' ? '검토 찾는 중…' : '검토하러 가기'}
        </button>
      </span> : <b>{transferEndpoint.status}</b>}
      {reviewSettled ? <p className="ledger-explorer-endpoint__note">검토 답변이 확정되었습니다. 장부 반영은 자동으로 진행되며 완료되면 상태가 바뀝니다.</p> : null}
      {reviewNavigationStatus === 'none' ? <p className="ledger-explorer-endpoint__note">이 거래에 열린 검토가 없습니다. 이미 답한 검토라면 장부 반영이 끝나는 대로 상태가 바뀝니다.</p> : null}
      {reviewNavigationStatus === 'error' ? <p role="alert">검토 목록을 불러오지 못했습니다. 새로고침한 뒤 다시 시도해 주세요.</p> : null}
    </section> : null}

    <section className="ledger-explorer-detail__postings" aria-labelledby={`posting-title-${event.eventId}`}>
      <header>
        <div><span>확정 장부</span><h3 id={`posting-title-${event.eventId}`}>자산 변동과 세무 입력</h3></div>
        <b>{event.postings.length}건</b>
      </header>
      {event.postings.length ? <div className="ledger-posting-table"><table><thead><tr><th>자산</th><th>방향</th><th>수량</th><th>역할</th><th>당시 취득·처분 금액</th><th>평균 단가</th><th>세무 취득원가</th></tr></thead><tbody>{event.postings.map((posting) => {
        const links = lotLineage?.links.filter((link) => link.legId === posting.legId) ?? []
        return <Fragment key={posting.legId}>
          <LedgerPostingRow posting={posting} postings={event.postings} effectiveAt={event.effectiveAt} />
          {links.length ? <tr className="ledger-lot-row"><td colSpan={7}>
            <LedgerLotLinks posting={posting} postings={event.postings} links={links} />
          </td></tr> : null}
        </Fragment>
      })}</tbody></table></div> : <p>현재 변경본에 확정된 장부 반영 내역이 없습니다.</p>}
      <LedgerLotNote status={lotStatus} lineage={lotLineage} />
    </section>

    <details className="ledger-explorer-provenance">
      <summary>검증용 원본 정보</summary>
      <dl>
        <div><dt>출처 식별자</dt><dd>{source.detail}</dd></div>
        <div><dt>거래 식별자</dt><dd>{event.transactionHash || event.eventId}</dd></div>
        {event.actionProfileId ? <div><dt>확정 분류 규칙</dt><dd>{event.actionProfileId}{event.actionProfileVersion ? ` · ${event.actionProfileVersion}` : ''}</dd></div> : null}
        {(event.projectedActions?.length ?? 0) > 1 ? <div><dt>확정 액션</dt><dd>{event.projectedActions!.map((item) => item.actionProfileId || item.subtype || item.eventType).join(' · ')}</dd></div> : null}
        {event.sourceEvents && event.sourceEvents.length > 1 ? <div><dt>통합된 장부 근거</dt><dd>{event.sourceEvents.length}개 변경본</dd></div> : null}
        <div><dt>자산 식별자</dt><dd>{[...new Set(event.postings.map((posting) => posting.assetId))].join(' · ') || '없음'}</dd></div>
        <div><dt>현재 변경본</dt><dd>{event.revisionNumber}번 · {event.revisionId}</dd></div>
        <div><dt>해석 상태</dt><dd>{event.interpretationSupport}</dd></div>
        <div><dt>흐름 코드</dt><dd>{event.flowShape}</dd></div>
        <div>
          <dt>원본 수량</dt>
          <dd>
            {event.postings
              .map((posting) => `${posting.legId}: ${posting.quantity}`)
              .join(' · ') || '없음'}
          </dd>
        </div>
      </dl>
    </details>
  </div>
}

export function LedgerPage() {
  const [year, setYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [ledgerEvents, setLedgerEvents] = useState<LedgerEventModel[]>([])
  const events = useMemo(() => projectLedgerTransactions(ledgerEvents), [ledgerEvents])
  const [ledgerSourceFilter, setLedgerSourceFilter] = useState<LedgerSourceFilter>('ALL')
  const [ledgerPageIndex, setLedgerPageIndex] = useState(0)
  const numberedEvents = useMemo(
    () => events.map((event, index) => ({ event, number: index + 1 })),
    [events],
  )
  const filteredEvents = useMemo(
    () => numberedEvents.filter(({ event }) => matchesLedgerSourceFilter(event, ledgerSourceFilter)),
    [ledgerSourceFilter, numberedEvents],
  )
  const ledgerPageCount = Math.max(1, Math.ceil(filteredEvents.length / ledgerRowsPerPage))
  const visibleEvents = useMemo(
    () => filteredEvents.slice(
      ledgerPageIndex * ledgerRowsPerPage,
      (ledgerPageIndex + 1) * ledgerRowsPerPage,
    ),
    [filteredEvents, ledgerPageIndex],
  )
  const ledgerGenerationRef = useRef(0)
  const [reviews, setReviews] = useState<ReviewModel[]>([])
  const [reviewCursor, setReviewCursor] = useState<string>()
  const [reviewPageStatus, setReviewPageStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [reviewStatus, setReviewStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [reviewReloadKey, setReviewReloadKey] = useState(0)
  const reviewListGenerationRef = useRef(0)
  const [reviewOccurredAtById, setReviewOccurredAtById] = useState<Record<string, string>>({})
  const [reviewPreviewById, setReviewPreviewById] = useState<Record<string, ReviewDetailModel>>({})
  const [reviewPreviewStatusById, setReviewPreviewStatusById] = useState<Record<string, ReviewPreviewStatus>>({})
  const reviewPreviewByIdRef = useRef<Record<string, ReviewDetailModel>>({})
  const reviewPreviewLoadingRef = useRef(new Set<string>())
  const [reviewNavigation, setReviewNavigation] = useState<{ eventId?: string; status: 'idle' | 'loading' | 'error' | 'resolved' | 'none' }>({ status: 'idle' })
  const [selectedId, setSelectedId] = useState<string>()
  const [lotLineage, setLotLineage] = useState<LedgerLotLineageModel>()
  const [lotStatus, setLotStatus] = useState<LotStatus>('idle')
  const lotGenerationRef = useRef(0)
  const [selectedReviewId, setSelectedReviewId] = useState<string>()
  const selectedReviewIdRef = useRef<string | undefined>(undefined)
  const reviewDetailGenerationRef = useRef(0)
  const [reviewDetail, setReviewDetail] = useState<ReviewDetailModel>()
  const [reviewDetailStatus, setReviewDetailStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [resolutionCode, setResolutionCode] = useState('')
  const [resolutionNote, setResolutionNote] = useState('')
  const [resolutionStatus, setResolutionStatus] = useState<'idle' | 'submitting' | 'refreshing' | 'success' | 'error' | 'stale' | 'stale-error' | 'conflict' | 'reanalyze'>('idle')
  const [resolutionIntentKey, setResolutionIntentKey] = useState<string>()
  const [reviewCompletion, setReviewCompletion] = useState<string>()
  const [view, setView] = useState<'ledger' | 'review'>(initialLedgerView)
  const [ledgerStatus, setLedgerStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [ledgerReloadKey, setLedgerReloadKey] = useState(0)
  const [metrics, setMetrics] = useState<DashboardModel>()
  const [metricsStatus, setMetricsStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  const cacheReviewDetail = useCallback((review: ReviewDetailModel) => {
    reviewPreviewByIdRef.current = {
      ...reviewPreviewByIdRef.current,
      [review.id]: review,
    }
    setReviewPreviewById((current) => current[review.id] === review
      ? current
      : { ...current, [review.id]: review })
    setReviewPreviewStatusById((current) => current[review.id] === 'ready'
      ? current
      : { ...current, [review.id]: 'ready' })
    const occurredAt = review.observations
      .map((observation) => observation.occurredAt)
      .filter((value): value is string => Boolean(value))
      .sort()[0]
    if (occurredAt) {
      setReviewOccurredAtById((current) => current[review.id] === occurredAt
        ? current
        : { ...current, [review.id]: occurredAt })
    }
  }, [])

  const requestReviewPreview = useCallback((reviewId: string) => {
    if (
      reviewPreviewByIdRef.current[reviewId] ||
      reviewPreviewLoadingRef.current.has(reviewId) ||
      selectedReviewIdRef.current === reviewId
    ) return
    const generation = reviewListGenerationRef.current
    reviewPreviewLoadingRef.current.add(reviewId)
    setReviewPreviewStatusById((current) => ({ ...current, [reviewId]: 'loading' }))
    void loadReview(reviewId)
      .then(({ review }) => {
        if (reviewListGenerationRef.current === generation) cacheReviewDetail(review)
      })
      .catch(() => {
        if (reviewListGenerationRef.current === generation) {
          setReviewPreviewStatusById((current) => ({ ...current, [reviewId]: 'error' }))
        }
      })
      .finally(() => reviewPreviewLoadingRef.current.delete(reviewId))
  }, [cacheReviewDetail])

  function handleYearChange(nextYear: AppYear) {
    setYear(nextYear)
    saveAppYear(nextYear)
  }

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++ledgerGenerationRef.current
    setLedgerStatus('loading')
    setLedgerEvents([])
    setLedgerPageIndex(0)
    setSelectedId(undefined)
    void loadAllLedger(year, { signal: controller.signal })
      .then((ledger) => {
        if (ledgerGenerationRef.current !== generation) return
        setLedgerEvents(ledger.items)
        setLedgerStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          ledgerGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setLedgerStatus('error')
      })
    return () => controller.abort()
  }, [ledgerReloadKey, year])

  useEffect(() => {
    const controller = new AbortController()
    setMetrics(undefined)
    setMetricsStatus('loading')
    void loadDashboard(year, controller.signal)
      .then(({ dashboard }) => {
        if (!dashboard) {
          setMetricsStatus('error')
          return
        }
        setMetrics(dashboard)
        setMetricsStatus('ready')
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setMetricsStatus('error')
        }
      })
    return () => controller.abort()
  }, [ledgerReloadKey, year])

  useEffect(() => {
    const generation = ++lotGenerationRef.current
    const selected = events.find((event) => event.eventId === selectedId)
    setLotLineage(undefined)
    if (!selected) {
      setLotStatus('idle')
      return
    }
    const controller = new AbortController()
    setLotStatus('loading')
    void loadLedgerEventLots(selected.eventId, selected.revisionId, controller.signal)
      .then((lineage) => {
        if (lotGenerationRef.current !== generation) return
        setLotLineage(lineage)
        setLotStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          lotGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setLotStatus('error')
      })
    return () => controller.abort()
  }, [events, selectedId])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++reviewListGenerationRef.current
    setReviewStatus('loading')
    setReviewPageStatus('idle')
    setReviewNavigation({ status: 'idle' })
    setReviewCompletion(undefined)
    setReviews([])
    setReviewCursor(undefined)
    reviewPreviewByIdRef.current = {}
    reviewPreviewLoadingRef.current.clear()
    setReviewPreviewById({})
    setReviewPreviewStatusById({})
    setReviewOccurredAtById({})
    selectedReviewIdRef.current = undefined
    setSelectedReviewId(undefined)
    void loadReviews(year, { signal: controller.signal })
      .then((review) => {
        if (reviewListGenerationRef.current !== generation) return
        setReviews(review.items)
        setReviewCursor(review.nextCursor)
        const firstReviewId = review.items[0]?.id
        selectedReviewIdRef.current = firstReviewId
        setSelectedReviewId(firstReviewId)
        setReviewStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          reviewListGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) setReviewStatus('error')
      })
    return () => controller.abort()
  }, [reviewReloadKey, year])

  useEffect(() => {
    selectedReviewIdRef.current = selectedReviewId
    const generation = ++reviewDetailGenerationRef.current
    if (!selectedReviewId) {
      setReviewDetail(undefined)
      setReviewDetailStatus('idle')
      return
    }
    const controller = new AbortController()
    setReviewDetailStatus('loading')
    setResolutionStatus('idle')
    setResolutionIntentKey(undefined)
    void loadReview(selectedReviewId, controller.signal)
      .then(({ review }) => {
        if (
          selectedReviewIdRef.current !== selectedReviewId ||
          reviewDetailGenerationRef.current !== generation
        ) return
        setReviewDetail(review)
        cacheReviewDetail(review)
        setResolutionCode(review.options[0]?.code ?? '')
        setResolutionNote('')
        setReviewDetailStatus('ready')
      })
      .catch((error: unknown) => {
        if (
          selectedReviewIdRef.current === selectedReviewId &&
          reviewDetailGenerationRef.current === generation &&
          !(error instanceof DOMException && error.name === 'AbortError')
        ) {
          setReviewDetailStatus('error')
          setReviewPreviewStatusById((current) => ({ ...current, [selectedReviewId]: 'error' }))
        }
      })
    return () => controller.abort()
  }, [cacheReviewDetail, selectedReviewId])

  useEffect(() => {
    if (!reviewCompletion || selectedReviewId || reviews.length === 0) return
    const nextReviewId = reviews.find((review) => review.status === 'OPEN')?.id
    if (!nextReviewId) return
    selectedReviewIdRef.current = nextReviewId
    setSelectedReviewId(nextReviewId)
  }, [reviewCompletion, reviews, selectedReviewId])

  const selectedOption = reviewDetail?.options.find((option) => option.code === resolutionCode)
  const resolutionBusy = resolutionStatus === 'submitting' || resolutionStatus === 'refreshing'
  const resolutionBlocked = resolutionStatus === 'reanalyze'
  const ledgerCount = metricsStatus === 'ready'
    ? formatMetricCount(metrics?.transactionCount)
    : '—'
  const reviewCount = metricsStatus === 'ready'
    ? formatMetricCount(metrics?.openReviewCount)
    : '—'

  const selectReview = (reviewId: string) => {
    setReviewCompletion(undefined)
    selectedReviewIdRef.current = reviewId
    setSelectedReviewId(reviewId)
  }

  const changeResolutionCode = (code: string) => {
    setResolutionCode(code)
    setResolutionIntentKey(undefined)
    setResolutionStatus('idle')
  }

  const changeResolutionNote = (note: string) => {
    setResolutionNote(note)
    setResolutionIntentKey(undefined)
    setResolutionStatus('idle')
  }

  const changeLedgerSourceFilter = (sourceFilter: LedgerSourceFilter) => {
    setLedgerSourceFilter(sourceFilter)
    setLedgerPageIndex(0)
    setSelectedId(undefined)
  }

  const loadMoreReviews = async () => {
    if (!reviewCursor || reviewPageStatus === 'loading') return
    const generation = reviewListGenerationRef.current
    setReviewPageStatus('loading')
    try {
      const page = await loadReviews(year, { cursor: reviewCursor })
      if (reviewListGenerationRef.current !== generation) return
      setReviews((current) => {
        const seen = new Set(current.map((review) => review.id))
        return [...current, ...page.items.filter((review) => !seen.has(review.id))]
      })
      setReviewCursor(page.nextCursor)
      setReviewPageStatus('idle')
    } catch {
      if (reviewListGenerationRef.current === generation) setReviewPageStatus('error')
    }
  }

  const loadNextLedgerPage = () => {
    setSelectedId(undefined)
    setLedgerPageIndex((current) => Math.min(ledgerPageCount - 1, current + 1))
  }

  const loadPreviousLedgerPage = () => {
    setSelectedId(undefined)
    setLedgerPageIndex((current) => Math.max(0, current - 1))
  }

  const openReviewForEvent = async (eventId: string) => {
    if (reviewNavigation.status === 'loading') return
    const loadedReview = reviews.find((review) => review.executionId === eventId && review.status === 'OPEN')
    if (loadedReview) {
      selectReview(loadedReview.id)
      setReviewNavigation({ status: 'idle' })
      setView('review')
      return
    }
    let sawSettledReview = reviews.some((review) => review.executionId === eventId)

    const generation = reviewListGenerationRef.current
    let cursor = reviewCursor
    const loadedIds = new Set(reviews.map((review) => review.id))
    setReviewNavigation({ eventId, status: 'loading' })
    try {
      while (cursor) {
        const page = await loadReviews(year, { cursor })
        if (reviewListGenerationRef.current !== generation) return
        const newItems = page.items.filter((review) => !loadedIds.has(review.id))
        newItems.forEach((review) => loadedIds.add(review.id))
        setReviews((current) => [...current, ...newItems])
        setReviewCursor(page.nextCursor)
        const matchingReview = page.items.find((review) => review.executionId === eventId && review.status === 'OPEN')
        if (matchingReview) {
          selectReview(matchingReview.id)
          setReviewNavigation({ status: 'idle' })
          setView('review')
          return
        }
        if (page.items.some((review) => review.executionId === eventId)) sawSettledReview = true
        cursor = page.nextCursor
      }
      // 전체 목록을 다 봤는데 열린 검토가 없다. 목록 API 는 열린 검토만
      // 돌려주므로 '이미 확정됨'과 '애초에 없음'은 여기서 구분할 수 없다 —
      // 두 경우를 모두 덮는 안내 하나로 합친다.
      setReviewNavigation({ eventId, status: sawSettledReview ? 'resolved' : 'none' })
    } catch {
      if (reviewListGenerationRef.current === generation) {
        setReviewNavigation({ eventId, status: 'error' })
      }
    }
  }

  const submitResolution = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!reviewDetail || !resolutionCode || resolutionBusy || resolutionBlocked) return
    const submittedReviewId = reviewDetail.id
    const submittedGeneration = reviewDetailGenerationRef.current
    const intentKey = resolutionIntentKey ?? crypto.randomUUID()
    setResolutionIntentKey(intentKey)
    setResolutionStatus('submitting')
    try {
      const result = await resolveReview(submittedReviewId, {
        expectedRevisionId: reviewDetail.revisionId,
        expectedPointerVersion: String(reviewDetail.pointerVersion),
        resolutionCode,
        resolutionNote,
        intentKey,
      })
      const submittedSelectionIsCurrent = (
        selectedReviewIdRef.current === submittedReviewId &&
        reviewDetailGenerationRef.current === submittedGeneration
      )

      if (result.review.status !== 'OPEN') {
        setReviews((current) => current.filter((review) => (
          review.id !== result.review.id && review.status === 'OPEN'
        )))
        setLedgerReloadKey((current) => current + 1)
        if (!submittedSelectionIsCurrent) return
        setReviewCompletion(describeReviewResolution(result.review))
        selectedReviewIdRef.current = undefined
        setSelectedReviewId(undefined)
        setReviewDetail(undefined)
        setResolutionStatus('success')
        setResolutionIntentKey(undefined)
        return
      }

      if (!submittedSelectionIsCurrent) return

      setReviews((current) => current.map((review) => review.id === result.review.id ? {
        ...review,
        revisionId: result.review.revisionId,
        pointerVersion: result.review.pointerVersion,
        status: result.review.status,
      } : review))
      setReviewDetail(result.review)
      cacheReviewDetail(result.review)
      setResolutionStatus('success')
      setResolutionIntentKey(undefined)
    } catch (error) {
      if (
        selectedReviewIdRef.current !== submittedReviewId ||
        reviewDetailGenerationRef.current !== submittedGeneration
      ) return
      if (error instanceof ApiClientError && error.code === 'REVIEW_STALE') {
        setResolutionStatus('refreshing')
        setResolutionIntentKey(undefined)
        try {
          const latest = await loadReview(submittedReviewId)
          if (
            selectedReviewIdRef.current !== submittedReviewId ||
            reviewDetailGenerationRef.current !== submittedGeneration
          ) return
          setReviewDetail(latest.review)
          cacheReviewDetail(latest.review)
          setResolutionCode(latest.review.options[0]?.code ?? '')
          setResolutionNote('')
          setResolutionStatus('stale')
        } catch {
          if (
            selectedReviewIdRef.current === submittedReviewId &&
            reviewDetailGenerationRef.current === submittedGeneration
          ) {
            setResolutionStatus('stale-error')
          }
        }
        return
      }
      if (error instanceof ApiClientError && error.code === 'REVIEW_INTENT_CONFLICT') {
        setResolutionIntentKey(undefined)
        setResolutionStatus('conflict')
        return
      }
      if (error instanceof ApiClientError && error.code === 'REVIEW_LINEAGE_UNAVAILABLE') {
        setResolutionIntentKey(undefined)
        setResolutionStatus('reanalyze')
        return
      }
      setResolutionStatus('error')
    }
  }

  const selectedReviewObservation = reviewDetail?.observations[0]
  const selectedReviewEvent = reviewDetail
    ? events.find((event) => event.eventId === reviewDetail.executionId)
    : undefined
  const selectedReviewSource = selectedReviewObservation
    ? formatReviewSource(selectedReviewObservation)
    : undefined
  const selectedReviewTitle = selectedReviewObservation && selectedReviewSource
    ? `${selectedReviewSource.label} · ${formatReviewKind(selectedReviewObservation)}`
    : reviewDetail
      ? describeReviewReason(reviewDetail.reasonCodes[0] ?? '')
      : ''
  const selectedReviewOccurredAt = selectedReviewEvent?.effectiveAt
    ?? selectedReviewObservation?.occurredAt

  return (
    <div className="ledger-page product-shell">
      <AppSidebar
        activePage="ledger"
        year={year}
        onYearChange={handleYearChange}
      />
      <main className="ledger-main">
        <section className="ledger-header" aria-labelledby="ledger-page-title">
          <div className="ledger-header__copy">
            <p>장부 작업</p>
            <h1 id="ledger-page-title">거래 장부</h1>
            <span>수집된 거래와 검토가 필요한 항목을 한곳에서 확인합니다.</span>
          </div>
          <div className="ledger-header__actions">
            <button
              type="button"
              aria-label={`전체 거래 ${ledgerCount}`}
              aria-pressed={view === 'ledger'}
              className={view === 'ledger' ? 'is-active' : undefined}
              onClick={() => setView('ledger')}
            >
              <span>전체 거래</span>
              <strong>{ledgerCount}</strong>
            </button>
            <button
              type="button"
              aria-label={`검토 필요 ${reviewCount}`}
              aria-pressed={view === 'review'}
              className={view === 'review' ? 'is-active' : undefined}
              onClick={() => setView('review')}
            >
              <span>검토 필요</span>
              <strong>{reviewCount}</strong>
            </button>
          </div>
        </section>

        {view === 'ledger' && ledgerStatus === 'error' ? (
          <section className="ledger-state-card ledger-state-card--error" role="alert">
            <h2>장부를 불러오지 못했습니다</h2>
            <p>잠시 후 다시 시도해 주세요. 계속 문제가 생기면 운영팀에 문의해 주세요</p>
            <button type="button" onClick={() => setLedgerReloadKey((current) => current + 1)}>장부 다시 불러오기</button>
          </section>
        ) : null}
        {view === 'ledger' && ledgerStatus === 'loading' ? (
          <section className="ledger-state-card ledger-state-card--loading" role="status">
            <p>장부를 불러오는 중입니다</p>
          </section>
        ) : null}

        {ledgerStatus === 'ready' && view === 'ledger' ? (
          events.length === 0 ? (
            <section className="ledger-state-card ledger-state-card--empty">
              <h2>아직 처리된 거래가 없습니다</h2>
              <p>데이터 소스를 등록하고 거래 수집이 완료되면 실제 거래가 여기에 표시됩니다</p>
              <AppLink href="/sources">데이터 소스 관리</AppLink>
            </section>
          ) : (
            <section className="ledger-explorer" aria-label="거래 장부">
              <header className="ledger-explorer__heading">
                <div className="ledger-explorer__summary">
                  <h2>거래</h2>
                  <span>표시 {filteredEvents.length}건 · 장부 항목 {filteredEvents.reduce((count, item) => count + item.event.postings.length, 0)}개</span>
                </div>
                <div className="ledger-explorer__toolbar">
                  <div className="ledger-source-filter" role="group" aria-label="거래 출처 필터">
                    <button type="button" className={ledgerSourceFilter === 'ALL' ? 'is-active' : undefined} aria-pressed={ledgerSourceFilter === 'ALL'} onClick={() => changeLedgerSourceFilter('ALL')}>전체</button>
                    <button type="button" className={ledgerSourceFilter === 'CEX' ? 'is-active' : undefined} aria-pressed={ledgerSourceFilter === 'CEX'} onClick={() => changeLedgerSourceFilter('CEX')}>거래소 · CEX</button>
                    <button type="button" className={ledgerSourceFilter === 'WALLET' ? 'is-active' : undefined} aria-pressed={ledgerSourceFilter === 'WALLET'} onClick={() => changeLedgerSourceFilter('WALLET')}>지갑 · EVM</button>
                  </div>
                  <nav className="ledger-page-controls" aria-label="거래 페이지">
                    <button type="button" aria-label="이전 거래 페이지" disabled={ledgerPageIndex === 0} onClick={loadPreviousLedgerPage}>이전</button>
                    <span><strong>{ledgerPageIndex + 1}</strong> / {ledgerPageCount}</span>
                    <button type="button" aria-label="다음 거래 페이지" disabled={ledgerPageIndex + 1 >= ledgerPageCount} onClick={loadNextLedgerPage}>다음</button>
                  </nav>
                </div>
              </header>
              <div className="ledger-explorer__table-wrap">
                <table className="ledger-explorer__table">
                  <thead><tr><th>번호</th><th>시간</th><th>출처 / 거래</th><th>확인된 액션</th><th>내 자산 변화</th><th>수수료</th><th>상태</th></tr></thead>
                  <tbody>{visibleEvents.map(({ event, number }) => {
                    const source = describeLedgerSource(event.postings)
                    const material = event.postings.filter((posting) => !feeRoles.has(posting.role))
                    const fees = event.postings.filter((posting) => feeRoles.has(posting.role))
                    const action = describeProjectedAction(event)
                    const isOpen = event.eventId === selectedId
                    return <Fragment key={event.eventId}>
                      <tr
                        className={isOpen ? 'ledger-explorer__row is-open' : 'ledger-explorer__row'}
                        onClick={() => setSelectedId(isOpen ? undefined : event.eventId)}
                      >
                        <td className="ledger-explorer__number">No. {number}</td>
                        <td className="ledger-explorer__time">
                          <span className="ledger-explorer__time-content">
                            <button type="button" className="ledger-explorer__toggle" aria-label={`${action.label} 거래 상세 ${isOpen ? '접기' : '보기'}`} aria-expanded={isOpen} aria-controls={`ledger-detail-${event.eventId}`} />
                            <time dateTime={event.effectiveAt}>{formatLedgerDateTime(event.effectiveAt)}</time>
                          </span>
                        </td>
                        <td><span className="ledger-explorer__source"><strong>{source.label}</strong><small>{sourceKindLabels[source.kind]}</small></span></td>
                        <td><span className="ledger-explorer__action" data-action={action.label}><strong>{action.label}</strong><small>{action.description}</small></span></td>
                        <td><LedgerMovementList postings={material} /></td>
                        <td><LedgerMovementList postings={fees} /></td>
                        <td><LedgerStatusBadges event={event} /></td>
                      </tr>
                      {isOpen ? <tr className="ledger-explorer__detail-row"><td colSpan={7}><div className="ledger-explorer__detail-panel" id={`ledger-detail-${event.eventId}`}><LedgerExplorerDetail
                        event={event}
                        reviewNavigationStatus={reviewNavigation.eventId === event.eventId ? reviewNavigation.status : 'idle'}
                        knownReviewStatus={reviews.find((review) => review.executionId === event.eventId)?.status}
                        onOpenReview={openReviewForEvent}
                        lotStatus={lotStatus}
                        lotLineage={lotLineage}
                      /></div></td></tr> : null}
                    </Fragment>
                  })}
                  {!visibleEvents.length ? <tr className="ledger-explorer__filtered-empty"><td colSpan={7}>선택한 출처의 거래가 없습니다</td></tr> : null}
                  </tbody>
                </table>
              </div>
            </section>
          )
        ) : null}

        {view === 'review' ? (
          <p className="ledger-review-scope">
            선택한 연도에 발생한 검토 필요 거래를 보여줍니다
          </p>
        ) : null}
        {view === 'review' && reviewStatus === 'loading' ? (
          <section className="ledger-state-card ledger-state-card--loading" role="status">
            <p>검토 목록을 불러오는 중입니다</p>
          </section>
        ) : null}
        {view === 'review' && reviewStatus === 'error' ? (
          <section className="ledger-state-card ledger-state-card--error" role="alert">
            <h2>검토 목록을 불러오지 못했습니다</h2>
            <p>장부는 계속 확인할 수 있습니다</p>
            <button type="button" onClick={() => setReviewReloadKey((current) => current + 1)}>검토 다시 불러오기</button>
          </section>
        ) : null}

        {reviewStatus === 'ready' && view === 'review' ? (
          <>
            {reviewCompletion ? <ReviewSubmissionNotice resolution={reviewCompletion} /> : null}
            {reviews.length === 0 ? <section className="ledger-state-card ledger-state-card--empty"><h2>열린 검토가 없습니다</h2><p>추가 확인이 필요한 거래가 생기면 사유와 근거가 여기에 표시됩니다</p></section> :
            <section className="ledger-review-browser" aria-label="열린 검토">
            <div className="ledger-review-browser__list" tabIndex={0} aria-label="검토 항목 목록">
              {reviews.map((review) => {
                const event = events.find((candidate) => candidate.eventId === review.executionId)
                return <ReviewListCard
                  key={review.id}
                  review={review}
                  detail={reviewPreviewById[review.id]}
                  event={event}
                  selected={review.id === selectedReviewId}
                  occurredAt={reviewOccurredAtById[review.id]}
                  previewStatus={reviewPreviewStatusById[review.id] ?? (reviewPreviewById[review.id] || event ? 'ready' : 'idle')}
                  onSelect={selectReview}
                  onRequestDetail={requestReviewPreview}
                />
              })}
              {reviewCursor ? <button type="button" className="ledger-review-browser__more" onClick={loadMoreReviews} disabled={reviewPageStatus === 'loading'}>
                {reviewPageStatus === 'loading' ? '검토 불러오는 중…' : '검토 더 보기'}
              </button> : null}
              {reviewPageStatus === 'error' ? <p role="alert">다음 검토 목록을 불러오지 못했습니다. 다시 시도해 주세요.</p> : null}
            </div>
            <div className="ledger-review-browser__detail">
              {reviewDetailStatus === 'loading' ? <p role="status">검토 상세를 불러오는 중입니다.</p> : null}
              {reviewDetailStatus === 'error' ? <p role="alert">검토 상세를 불러오지 못했습니다.</p> : null}
              {reviewDetailStatus === 'ready' && reviewDetail ? <article>
                <header className="ledger-review-detail__header">
                  <div>
                    <span>거래 검토</span>
                    <h2>{selectedReviewTitle}</h2>
                    {selectedReviewObservation && selectedReviewSource ? <p>
                      <b>{selectedReviewSource.type}</b>
                      <span>{formatReviewDisplayQuantity(selectedReviewObservation)}</span>
                      <span>{selectedReviewOccurredAt
                        ? formatLedgerDateTime(selectedReviewOccurredAt)
                        : '시간 정보 없음'}</span>
                    </p> : null}
                  </div>
                  <b>{statusLabel(reviewDetail.status)}</b>
                </header>
                <section className="ledger-review-evidence" aria-labelledby="review-evidence-heading">
                  <header>
                    <div><span>검토 근거</span><h3 id="review-evidence-heading">응답할 거래 근거</h3></div>
                    <b>{reviewDetail.observations.length}건</b>
                  </header>
                  <p>자산과 수량을 먼저 확인하고, 필요하면 원본 정보를 펼쳐 보세요.</p>
                  <ul>
                    {reviewDetail.observations.map((observation) => <ReviewObservationEvidence
                      key={`${observation.fragmentId}:${observation.observationId}`}
                      observation={observation}
                    />)}
                  </ul>
                </section>
                {reviewDetail.status === 'OPEN' ? <form className="ledger-review-form" onSubmit={submitResolution}>
                  <fieldset disabled={resolutionBusy || resolutionBlocked}>
                    <legend>이 거래를 어떻게 처리할까요?</legend>
                    {reviewDetail.options.map((option) => <label key={option.code}>
                      <input type="radio" name="resolutionCode" value={option.code} checked={resolutionCode === option.code} onChange={() => changeResolutionCode(option.code)} />
                      <span><strong>{option.label}</strong><small>{option.requiresEvidence ? '근거 설명 필수' : '추가 설명 선택'}</small></span>
                    </label>)}
                  </fieldset>
                  <label className="ledger-review-form__note">
                    <span>검토 메모{selectedOption?.requiresEvidence ? ' (필수)' : ' (선택)'}</span>
                    <textarea value={resolutionNote} onChange={(event) => changeResolutionNote(event.target.value)} maxLength={4000} required={selectedOption?.requiresEvidence} disabled={resolutionBusy || resolutionBlocked} placeholder="판단 근거나 거래 맥락을 남겨 주세요." />
                  </label>
                  <button type="submit" disabled={!resolutionCode || resolutionBusy || resolutionBlocked || Boolean(selectedOption?.requiresEvidence && !resolutionNote.trim())}>
                    {resolutionStatus === 'submitting' ? '응답 저장 중…' : resolutionStatus === 'refreshing' ? '최신 응답 불러오는 중…' : resolutionStatus === 'reanalyze' ? '운영 확인 필요' : '이 응답으로 검토 완료'}
                  </button>
                  {resolutionStatus === 'submitting' ? <p role="status">검토 응답을 안전하게 저장하는 중입니다.</p> : null}
                  {resolutionStatus === 'refreshing' ? <p role="status">다른 변경이 먼저 반영되어 최신 내용을 불러오는 중입니다.</p> : null}
                  {resolutionStatus === 'stale' ? <p role="alert">다른 변경이 먼저 반영되어 최신 내용을 다시 불러왔습니다. 응답을 확인해 다시 제출해 주세요.</p> : null}
                  {resolutionStatus === 'stale-error' ? <p role="alert">변경된 최신 내용을 불러오지 못했습니다. 화면을 새로고침한 뒤 다시 시도해 주세요.</p> : null}
                  {resolutionStatus === 'conflict' ? <p role="alert">같은 요청을 처리하는 중 내용이 달라졌습니다. 최신 내용을 확인한 뒤 다시 제출해 주세요.</p> : null}
                  {resolutionStatus === 'reanalyze' ? <p role="alert">이 검토에는 필요한 분석 정보가 없어 응답을 저장하지 않았습니다. 운영팀이 데이터 준비 상태를 확인해야 합니다.</p> : null}
                  {resolutionStatus === 'error' ? <p role="alert">응답을 저장하지 못했습니다. 같은 요청으로 다시 시도할 수 있습니다.</p> : null}
                </form> : <ReviewSubmissionNotice resolution={describeReviewResolution(reviewDetail)} />}
                <ReviewTechnicalDetails review={reviewDetail} />
              </article> : null}
            </div>
            </section>}
          </>
        ) : null}
      </main>
    </div>
  )
}
