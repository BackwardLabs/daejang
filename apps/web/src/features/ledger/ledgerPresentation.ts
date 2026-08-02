const integerQuantityPattern = /^-?\d+$/
const decimalScalePattern = /^decimal(\d+)$/i
const integerGroupPattern = /\B(?=(\d{3})+(?!\d))/g

export type LedgerAssetPresentation = {
  symbol: string
  decimals?: number
  metadata?: string
}

export type LedgerPostingRolePresentation = {
  label: string
  description: string
}

export type LedgerSourcePresentation = {
  kind: 'CEX' | 'WALLET' | 'UNKNOWN'
  label: string
  detail: string
}

export type LedgerActionPresentation = {
  label: string
  description: string
}

export type LedgerTransferEndpointPresentation = {
  label: '보낸 곳' | '받는 곳' | '상대 정보'
  title: string
  detail: string
  status: string
  tone: 'success' | 'warning' | 'neutral'
}

export type LedgerValuePosting = {
  assetId: string
  assetSymbol?: string
  assetDecimals?: number
  hasAssetDecimals?: boolean
  assetVenue?: string
  direction: string
  quantity: string
  role: string
  fairValue?: string
  denomination: string
}

const canonicalDenominations: Record<string, LedgerAssetPresentation> = {
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}

const postingRoles: Record<string, LedgerPostingRolePresentation> = {
  PRINCIPAL: {
    label: '주 거래',
    description: '매수·매도·입출금의 본체가 되는 자산 변동',
  },
  FEE: {
    label: '거래 수수료',
    description: '거래소나 서비스에 지불한 처리 비용',
  },
  GAS: {
    label: '네트워크 수수료',
    description: '블록체인 거래 실행에 사용된 가스 비용',
  },
  INCOME: {
    label: '수익',
    description: '보상·이자 등으로 새로 들어온 자산',
  },
  ADJUSTMENT: {
    label: '조정',
    description: '정정이나 잔액 조정을 위해 반영한 변동',
  },
  OTHER: {
    label: '기타',
    description: '현재 세부 역할이 확정되지 않은 자산 변동',
  },
}

const directionLabels: Record<string, string> = {
  IN: '들어옴',
  OUT: '나감',
}

const flowShapeLabels: Record<string, string> = {
  EXCHANGE: '자산 교환',
  INFLOW_OUTFLOW: '자산 교환',
  SELF_TRANSFER: '내 계정 간 이동',
  EXTERNAL_IN: '외부에서 들어온 자산',
  EXTERNAL_OUT: '외부로 나간 자산',
  INCOME: '수익 발생',
  DEPOSIT_INTEREST: '거래소 예치금 이용료',
  AIRDROP: '에어드롭 지급',
  FIAT_IN: '본인 원화 입금',
  FIAT_OUT: '본인 원화 출금',
  COST_ONLY: '비용 발생',
  POSITION_CHANGE: '포지션 변경',
  UNKNOWN: '흐름 확인 필요',
}

const eventTypeLabels: Record<string, string> = {
  TRADE: '거래',
  SWAP: '스왑',
  BRIDGE: '브리지',
  REWARD: '보상',
  BORROW: '대여',
  REPAY: '상환',
  STAKE: '스테이킹',
  LIQUIDITY: '유동성',
  WRAP: '래핑',
  UNKNOWN: '미분류',
  OTHER: '기타',
}

const reviewReasonLabels: Record<string, string> = {
  UNKNOWN_TRANSACTION: '거래 유형 확인 필요',
  NEEDS_CONTEXT: '추가 정보 필요',
}

const nonMaterialPostingRoles = new Set(['FEE', 'GAS'])

const evmNetworkMetadata: Record<string, { label: string; nativeSymbol: string; decimals: number }> = {
  '1': { label: 'Ethereum', nativeSymbol: 'ETH', decimals: 18 },
  '10': { label: 'Optimism', nativeSymbol: 'ETH', decimals: 18 },
}

const describeChainCandidate = (value: string) => {
  const match = value.match(/^eip155:(\d+)$/i)
  if (!match?.[1]) return value
  return evmNetworkMetadata[match[1]]?.label ?? `EVM ${match[1]}`
}

const formatVenue = (value: string) =>
  value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : ''

export const parseLedgerAsset = (
  assetId: string,
  assetSymbol?: string,
  assetDecimals?: number,
  assetVenue?: string,
): LedgerAssetPresentation => {
  if (
    assetSymbol &&
    assetDecimals !== undefined &&
    Number.isSafeInteger(assetDecimals) &&
    assetDecimals >= 0 &&
    assetDecimals <= 255
  ) {
    const venue = formatVenue(assetVenue ?? '')
    return {
      symbol: assetSymbol,
      decimals: assetDecimals,
      metadata: `${venue ? `${venue} · ` : ''}소수점 ${assetDecimals}자리`,
    }
  }
  const [kind, venue, scale, symbol, ...remainder] = assetId.split(':')
  const scaleMatch = scale?.match(decimalScalePattern)
  const decimals = scaleMatch ? Number(scaleMatch[1]) : undefined
  if (
    kind === 'cex-document-asset' &&
    venue &&
    symbol &&
    remainder.length === 0 &&
    decimals !== undefined &&
    Number.isSafeInteger(decimals) &&
    decimals >= 0 &&
    decimals <= 255
  ) {
    return {
      symbol: symbol.toUpperCase(),
      decimals,
      metadata: `${formatVenue(venue)} · 소수점 ${decimals}자리`,
    }
  }
  const evmMatch = assetId.match(/^asset:eip155:(\d+):(native|erc20)(?::(.+))?$/i)
  if (evmMatch) {
    const [, chainId = '', assetKind = ''] = evmMatch
    const network = evmNetworkMetadata[chainId]
    const networkLabel = network?.label ?? `EVM ${chainId}`
    if (assetKind.toLowerCase() === 'native' && network) {
      return {
        symbol: network.nativeSymbol,
        decimals: network.decimals,
        metadata: `${network.label} · 네이티브 자산`,
      }
    }
    if (assetKind.toLowerCase() === 'native') {
      return {
        symbol: '네이티브 자산',
        metadata: `${networkLabel} · 네이티브 자산 메타데이터 확인 필요`,
      }
    }
    return {
      symbol: 'ERC-20 토큰',
      metadata: `${networkLabel} · 토큰 메타데이터 확인 필요`,
    }
  }
  return {
    symbol: '자산 확인 필요',
    metadata: assetId ? '원본 자산 식별자를 확인해 주세요' : undefined,
  }
}

export const describeLedgerSource = (
  postings: Array<{ accountId: string; assetId: string }>,
): LedgerSourcePresentation => {
  for (const posting of postings) {
    const cexAccountMatch = posting.accountId.match(/^cex-account:([^:]+):/i)
    if (cexAccountMatch?.[1]) {
      return {
        kind: 'CEX',
        label: formatVenue(cexAccountMatch[1]),
        detail: posting.accountId,
      }
    }
  }
  for (const posting of postings) {
    const cexMatch = posting.assetId.match(/^cex-document-asset:([^:]+):/i)
    if (cexMatch?.[1]) {
      return {
        kind: 'CEX',
        label: formatVenue(cexMatch[1]),
        detail: posting.accountId || '거래소 계정',
      }
    }
  }
  for (const posting of postings) {
    const evmMatch = posting.assetId.match(/^asset:eip155:(\d+):/i)
    if (evmMatch?.[1]) {
      return {
        kind: 'WALLET',
        label: evmNetworkMetadata[evmMatch[1]]?.label ?? `EVM ${evmMatch[1]}`,
        detail: posting.accountId || '개인지갑',
      }
    }
  }
  return {
    kind: 'UNKNOWN',
    label: '출처 확인 중',
    detail: postings[0]?.accountId || '연결 정보 없음',
  }
}

export const describeFlowShape = (flowShape: string) =>
  flowShapeLabels[flowShape] ?? '흐름 확인 필요'

export const describeLedgerAction = (
  eventType: string,
  flowShape: string,
  postings: Array<{ direction: string; role?: string }>,
  subtype = '',
): LedgerActionPresentation => {
  if (subtype === 'DEPOSIT_INTEREST') {
    return { label: '예치금 이용료', description: '거래소 예치금 이용료' }
  }
  if (subtype === 'AIRDROP') {
    return { label: '에어드롭', description: '디지털 자산 지급' }
  }
  if (subtype === 'FIAT_DEPOSIT') {
    return { label: '원화 입금', description: '본인 원화 입금' }
  }
  if (subtype === 'FIAT_WITHDRAWAL') {
    return { label: '원화 출금', description: '본인 원화 출금' }
  }
  if (subtype === 'LENDING_SUPPLY') {
    return { label: '자산 공급', description: '대출 포지션 증가' }
  }
  if (subtype === 'LENDING_WITHDRAW') {
    return { label: '자산 회수', description: '대출 포지션 감소' }
  }
  const description = describeFlowShape(flowShape)
  if (flowShape === 'DEPOSIT_INTEREST') return { label: '예치금 이용료', description }
  if (flowShape === 'AIRDROP') return { label: '에어드롭', description }
  if (flowShape === 'FIAT_IN') return { label: '원화 입금', description }
  if (flowShape === 'FIAT_OUT') return { label: '원화 출금', description }
  if (eventType !== 'TRANSFER') {
    return {
      label: eventTypeLabels[eventType] ?? '거래 유형 확인 필요',
      description,
    }
  }

  if (flowShape === 'EXTERNAL_IN') return { label: '입금', description }
  if (flowShape === 'EXTERNAL_OUT') return { label: '출금', description }
  if (flowShape === 'SELF_TRANSFER') return { label: '내 계정 이동', description }

  const materialPostings = postings.filter((posting) =>
    !posting.role || !nonMaterialPostingRoles.has(posting.role),
  )
  const hasIncoming = materialPostings.some((posting) => posting.direction === 'IN')
  const hasOutgoing = materialPostings.some((posting) => posting.direction === 'OUT')

  if (hasIncoming && !hasOutgoing) return { label: '입금', description }
  if (hasOutgoing && !hasIncoming) return { label: '출금', description }
  if (hasIncoming && hasOutgoing) return { label: '자산 이동', description }
  return { label: '입출금 확인', description }
}

export const describeTransferEndpoint = (
  postings: Array<{ direction: string; role?: string }>,
  endpoint?: {
    resolution: string
    display: string
    addressFamily?: string
    chainCandidates?: string[]
    connectionStatus: string
    reviewRequired: boolean
  },
): LedgerTransferEndpointPresentation => {
  const material = postings.filter((posting) =>
    !posting.role || !nonMaterialPostingRoles.has(posting.role),
  )
  const hasIncoming = material.some((posting) => posting.direction === 'IN')
  const hasOutgoing = material.some((posting) => posting.direction === 'OUT')
  const label = hasIncoming && !hasOutgoing
    ? '보낸 곳'
    : hasOutgoing && !hasIncoming
      ? '받는 곳'
      : '상대 정보'

  if (!endpoint || endpoint.resolution === 'UNKNOWN') {
    return {
      label,
      title: '확인 필요',
      detail: endpoint?.display || '상대 지갑 정보가 자료에 없습니다',
      status: '송신자·수신자 확인 필요',
      tone: 'warning',
    }
  }
  if (endpoint.resolution === 'OWNED_REGISTERED') {
    const network = endpoint.chainCandidates?.length
      ? ` · ${endpoint.chainCandidates.map(describeChainCandidate).join(', ')}`
      : endpoint.addressFamily
        ? ` · ${endpoint.addressFamily}`
        : ''
    return {
      label,
      title: '내 등록 지갑',
      detail: `${endpoint.display}${network}`,
      status: endpoint.connectionStatus === 'WALLET_OBSERVATION_PENDING'
        ? '반대편 지갑 장부 확인 대기'
        : '내 지갑 정보와 연결됨',
      tone: endpoint.reviewRequired ? 'warning' : 'success',
    }
  }
  if (endpoint.resolution === 'OWNED_SUBJECT_NAME') {
    return {
      label,
      title: '본인 명의',
      detail: endpoint.display || '본인 명의 입출금',
      status: endpoint.reviewRequired ? '본인 거래 여부 확인 필요' : '본인 정보와 일치',
      tone: endpoint.reviewRequired ? 'warning' : 'success',
    }
  }
  return {
    label,
    title: '외부 지갑',
    detail: endpoint.display || '식별된 외부 주소',
    status: endpoint.reviewRequired ? '거래 목적 확인 필요' : '외부 전송으로 확인',
    tone: endpoint.reviewRequired ? 'warning' : 'neutral',
  }
}

export const formatCanonicalQuantity = (
  quantity: string,
  assetDecimals?: number,
) => {
  if (!integerQuantityPattern.test(quantity)) return quantity || '—'
  if (assetDecimals === undefined) return `${quantity} (단위 확인 필요)`
  const negative = quantity.startsWith('-')
  const digits = negative ? quantity.slice(1) : quantity
  if (assetDecimals === 0) return `${negative ? '-' : ''}${digits}`
  const padded = digits.padStart(assetDecimals + 1, '0')
  const integer = padded.slice(0, -assetDecimals)
  const fraction = padded.slice(-assetDecimals).replace(/0+$/, '')
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`
}

export const formatLedgerQuantity = (
  quantity: string,
  assetDecimals?: number,
) => {
  const formatted = formatCanonicalQuantity(quantity, assetDecimals)
  if (formatted.endsWith(' (단위 확인 필요)') || formatted === '—') {
    return formatted
  }
  const negative = formatted.startsWith('-')
  const unsigned = negative ? formatted.slice(1) : formatted
  const [integer = '', fraction] = unsigned.split('.')
  const grouped = integer.replace(integerGroupPattern, ',')
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}

const postingAsset = (posting: LedgerValuePosting) => parseLedgerAsset(
  posting.assetId,
  posting.assetSymbol,
  posting.hasAssetDecimals ? posting.assetDecimals : undefined,
  posting.assetVenue,
)

const denominationAsset = (
  denomination: string,
  postings: LedgerValuePosting[],
) => {
  const denominationPosting = postings.find((posting) =>
    posting.assetId === denomination || posting.assetSymbol === denomination,
  )
  return denominationPosting
    ? postingAsset(denominationPosting)
    : canonicalDenominations[denomination]
}

export const formatLedgerMoney = (
  amount: string,
  denomination: string,
  postings: LedgerValuePosting[],
) => {
  if (!amount) return '—'
  const asset = denominationAsset(denomination, postings)
  if (!asset) return `${amount}${denomination ? ` ${denomination}` : ''}`
  return `${formatLedgerQuantity(amount, asset.decimals)} ${asset.symbol}`
}

export const formatLedgerUnitPrice = (
  posting: LedgerValuePosting,
  postings: LedgerValuePosting[],
) => {
  if (posting.role !== 'PRINCIPAL') return '—'
  const asset = postingAsset(posting)
  if (asset.symbol === 'KRW' || asset.decimals === undefined || !integerQuantityPattern.test(posting.quantity)) return '—'
  const tradeQuote = postings.find((candidate) => {
    const candidateAsset = postingAsset(candidate)
    return candidate.role === 'PRINCIPAL' &&
      candidate.direction !== posting.direction &&
      candidateAsset.symbol === 'KRW' &&
      candidateAsset.decimals !== undefined &&
      integerQuantityPattern.test(candidate.quantity)
  })
  const fairValueAsset = !tradeQuote && posting.fairValue
    ? denominationAsset(posting.denomination, postings)
    : undefined
  const quoteAsset = fairValueAsset ?? (tradeQuote ? postingAsset(tradeQuote) : undefined)
  const quoteQuantity = fairValueAsset ? posting.fairValue : tradeQuote?.quantity
  if (!quoteAsset || quoteAsset.decimals === undefined || !quoteQuantity || !integerQuantityPattern.test(quoteQuantity)) return '—'
  const baseUnits = BigInt(posting.quantity.replace(/^-/, ''))
  const quoteUnits = BigInt(quoteQuantity.replace(/^-/, ''))
  if (baseUnits === 0n || quoteUnits === 0n) return '—'
  const unscaledNumerator = quoteUnits * 10n ** BigInt(asset.decimals)
  const unscaledDenominator = baseUnits * 10n ** BigInt(quoteAsset.decimals)
  const integerPrice = unscaledNumerator / unscaledDenominator
  const displayDecimals = integerPrice >= 100n ? 2 : integerPrice >= 1n ? 4 : 8
  const numerator = quoteUnits * 10n ** BigInt(asset.decimals + displayDecimals)
  const denominator = unscaledDenominator
  const rounded = (numerator + denominator / 2n) / denominator
  return `${formatLedgerQuantity(rounded.toString(), displayDecimals)} KRW / ${asset.symbol}`
}

export const describePostingRole = (role: string) =>
  postingRoles[role] ?? {
    label: '역할 확인 필요',
    description: '원본 역할 코드를 아직 사용자용 설명으로 변환하지 못했습니다',
  }

export const describePostingDirection = (direction: string) =>
  directionLabels[direction] ?? '방향 확인 필요'

export const describeReviewReason = (reasonCode: string) =>
  reviewReasonLabels[reasonCode] ?? '추가 확인 필요'

const lotBasisStatusLabels: Record<string, string> = {
  KNOWN: '취득원가 확정',
  UNKNOWN: '취득원가 미확정',
  INHERITED: '취득원가 승계',
}

export const describeLotBasisStatus = (basisStatus: string) =>
  lotBasisStatusLabels[basisStatus] ?? '취득원가 상태 확인 필요'
