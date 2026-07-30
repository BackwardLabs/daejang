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
  return { symbol: assetId || '알 수 없는 자산' }
}

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
