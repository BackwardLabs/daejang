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
  COST_ONLY: '비용 발생',
  POSITION_CHANGE: '포지션 변경',
  UNKNOWN: '흐름 확인 필요',
}

const evmNetworkMetadata: Record<string, { label: string; nativeSymbol: string; decimals: number }> = {
  '1': { label: 'Ethereum', nativeSymbol: 'ETH', decimals: 18 },
  '10': { label: 'Optimism', nativeSymbol: 'ETH', decimals: 18 },
}

const formatVenue = (value: string) =>
  value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}` : ''

export const parseLedgerAsset = (assetId: string): LedgerAssetPresentation => {
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
    const [, chainId = '', assetKind = '', locator] = evmMatch
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
        symbol: assetId,
        metadata: `${networkLabel} · 네이티브 자산 메타데이터 확인 필요`,
      }
    }
    const compactLocator = locator && locator.length > 18
      ? `${locator.slice(0, 10)}…${locator.slice(-6)}`
      : locator
    return {
      symbol: compactLocator || 'ERC-20',
      metadata: `${networkLabel} · 토큰 메타데이터 확인 필요`,
    }
  }
  return { symbol: assetId || '알 수 없는 자산' }
}

export const describeLedgerSource = (
  postings: Array<{ accountId: string; assetId: string }>,
): LedgerSourcePresentation => {
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
  flowShapeLabels[flowShape] ?? (flowShape || '흐름 확인 필요')

export const formatCanonicalQuantity = (
  quantity: string,
  assetDecimals?: number,
) => {
  if (!integerQuantityPattern.test(quantity)) return quantity || '—'
  if (assetDecimals === undefined) return `${quantity} raw units`
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
  if (formatted.endsWith(' raw units') || formatted === '—') return formatted
  const negative = formatted.startsWith('-')
  const unsigned = negative ? formatted.slice(1) : formatted
  const [integer = '', fraction] = unsigned.split('.')
  const grouped = integer.replace(integerGroupPattern, ',')
  return `${negative ? '-' : ''}${grouped}${fraction ? `.${fraction}` : ''}`
}

export const describePostingRole = (role: string) =>
  postingRoles[role] ?? {
    label: role || '역할 미확인',
    description: '원본 역할 코드를 아직 사용자용 설명으로 변환하지 못했습니다',
  }

export const describePostingDirection = (direction: string) =>
  directionLabels[direction] ?? (direction || '미확인')
