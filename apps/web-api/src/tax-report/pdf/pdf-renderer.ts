import PDFDocument from 'pdfkit'

import type {
  ReportPrintAmountV1,
  ReportPrintCalculationRateV1,
  ReportPrintModelV1,
} from './report-print-model.js'

const page = {
  width: 595.28,
  height: 841.89,
  marginX: 42,
  top: 54,
  bottom: 52,
} as const

const colors = {
  ink: '#171717',
  muted: '#666666',
  faint: '#9A9A9A',
  line: '#DADADA',
  soft: '#F6F6F6',
  accent: '#F15A24',
} as const

type CellColumn = {
  header: string
  width: number
  align?: 'left' | 'right' | 'center'
}

type RenderOptions = {
  fontBytes: Buffer
  rendererVersion?: string
}

type TableOptions = {
  title: string
  emptyLabel: string
  columns: ReadonlyArray<CellColumn>
  rows: ReadonlyArray<ReadonlyArray<string>>
}

export const incomePolicyMappingLines = (mapping: {
  eventSubtype: string
  policyVersion: string
  policyArtifactDigest: string
} | null): string[] => mapping === null ? [] : [
  '보상 자산 취득 기준 적용',
  '원본 정책 근거 자료에 연결됨',
]

const formatDecimal = (value: string) => {
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
  KRW: { symbol: 'KRW', decimals: 0 },
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}

const formatAtomicAmount = (value: string, decimals: number) => {
  if (!/^-?\d+$/.test(value)) return formatDecimal(value)
  if (decimals === 0) return formatDecimal(value)
  const negative = value.startsWith('-')
  const digits = negative ? value.slice(1) : value
  const padded = digits.padStart(decimals + 1, '0')
  const integer = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return formatDecimal(
    `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`,
  )
}

const presentTaxAsset = (assetId: string) => {
  const symbol = assetId
    .replace(/^tax-asset-/i, '')
    .replace(/^asset-/i, '')
    .replace(/-upbit$/i, '')
  return /^[a-z0-9]{2,20}$/i.test(symbol) ? symbol.toUpperCase() : '기록된 자산'
}

const formatAssetQuantity = (
  quantity: string,
  taxAssetId: string,
  assetAtomicDecimals: number | null | undefined,
) => assetAtomicDecimals === null || assetAtomicDecimals === undefined
  ? '수량 단위 확인 필요'
  : `${formatAtomicAmount(quantity, assetAtomicDecimals)} ${presentTaxAsset(taxAssetId)}`

const formatReportAmountWithScale = (
  amount: ReportPrintAmountV1,
  denominationAssetId: string,
  denominationAtomicDecimals?: number,
) => {
  if (amount.status !== 'KNOWN') return '미확정(0원이 아님)'
  const presentation = reportDenominations[denominationAssetId]
  const decimals = denominationAtomicDecimals ?? presentation?.decimals
  if (decimals !== undefined) {
    const symbol = presentation?.symbol ?? (denominationAssetId === 'KRW' ? 'KRW' : '금액 단위 확인 필요')
    return `${formatAtomicAmount(
      amount.amount,
      decimals,
    )} ${symbol}`
  }
  return '금액 단위 확인 필요'
}

export const formatReportAmount = (
  amount: ReportPrintAmountV1,
  denominationAssetId: string,
) => formatReportAmountWithScale(amount, denominationAssetId)

export const deemedExpenseEvidenceRows = (
  model: Pick<ReportPrintModelV1, 'v2'>,
): Array<readonly [string, string, string]> => model.v2?.assetSummaries
  .filter((row) => row.basisEvidenceDigest !== null)
  .map((row) => [
    presentTaxAsset(row.taxAssetId),
    presentBasisApplicationReason(row.basisApplicationReasonCode),
    '원본 근거 자료에 연결됨',
  ]) ?? []

const presentBasisApplicationReason = (value: string | null) => ({
  NON_VASP_NO_BOOKS_OR_EVIDENCE: '장부·증빙이 충분하지 않은 비거래소 보유분',
  NTS_DESIGNATED_OTHER: '국세청 지정 요건에 따른 적용',
}[value ?? ''] ?? '법정 적용 사유 확인 필요')

export const formatValuationMarket = (
  valuation: { marketStatus: string; market: string | null },
) => valuation.marketStatus === 'NOT_APPLICABLE'
  ? '직접 평가 · 시장 코드 해당 없음'
  : valuation.market ?? '시장 정보 확인 필요'

export const formatKstTimestamp = (value: string) => {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const kst = new Date(timestamp + 9 * 60 * 60 * 1_000).toISOString()
  return `${kst.slice(0, 10)} ${kst.slice(11, 19)} KST`
}

const reportRowSourceLabel = <T extends object>(
  row: T & Partial<{
    sourceEvidence?: ReadonlyArray<{
      sourceKinds: ReadonlyArray<string>
      sourceArtifactBindingStatus: 'BOUND' | 'UNBOUND'
    }>
  }>,
) => {
  const sourceEvidence = row.sourceEvidence ?? []
  const kinds = [...new Set(sourceEvidence.flatMap(
    (evidence) => evidence.sourceKinds,
  ))].map((kind) => ({
    API: '연결된 거래 기록',
    FILE: '업로드한 원본 자료',
    MANUAL: '직접 입력 자료',
    CHAIN: '블록체인 기록',
    OTHER: '기타 자료',
  })[kind] ?? '출처 확인 필요')
  const binding = sourceEvidence.length > 0 && sourceEvidence.every(
    (evidence) => evidence.sourceArtifactBindingStatus === 'BOUND',
  )
    ? '원본 자료 연결됨'
    : '원본 자료 연결 확인 필요'
  return `${kinds.join(', ') || '출처 확인 필요'} · ${binding}`
}

const limitationLabels: Record<string, readonly [string, string]> = {
  FILING_ROUNDING_PROFILE_UNAPPROVED: ['신고용 반올림 기준 확인 필요', '현재 세액은 신고 전 추정치입니다.'],
  OPENING_INVENTORY_MISSING: ['이전 보유내역 확인 필요', '처분 시점 이전의 보유 기록이 충분하지 않습니다.'],
  SOURCE_COVERAGE_UNVERIFIED: ['자료 범위 확인 필요', '일부 원본 자료의 확인 범위가 확정되지 않았습니다.'],
  TRANSFER_ENDPOINT_REVIEW_REQUIRED: ['이체 상대 정보 확인 필요', '이체 상대방과 거래 성격을 확인해 주세요.'],
  UNKNOWN_ACQUISITION_BASIS: ['취득가액 확인 필요', '취득 당시 금액 근거가 충분하지 않습니다.'],
  UNKNOWN_DISPOSAL_BASIS: ['처분가액 확인 필요', '처분 당시 금액 근거가 충분하지 않습니다.'],
  UNRESOLVED_EVENT: ['거래 분류 확인 필요', '이 거래의 세무 분류를 확인해 주세요.'],
  UNRESOLVED_TAX_CHARACTERIZATION: ['과세 분류 확인 필요', '과세 여부를 확정할 정보가 부족합니다.'],
  UNRESOLVED_TRANSFER_TAX_TREATMENT: ['이체 처리 확인 필요', '자산 이동의 세무 처리를 확인해 주세요.'],
  VALUATION_DISPLAY_PROVENANCE_INCOMPLETE: ['가격 근거 확인 필요', '가격 산정에 사용한 자료를 모두 확인하지 못했습니다.'],
}

const presentLimitation = (code: string): readonly [string, string] =>
  limitationLabels[code] ?? ['계산 근거 확인 필요', '계산에 필요한 일부 정보를 확인해 주세요.']

const presentTransactionType = (value: string) => ({
  ACQUIRE: '자산 취득',
  OTHER_ACQUISITION: '기타 취득',
  DISPOSAL: '자산 처분',
  FEE_ASSET_DISPOSAL: '수수료로 사용한 자산 처분',
  LENDING_INCOME_CASH: '대여 수익(원화)',
  LENDING_INCOME_ASSET: '대여 수익(자산)',
  TRANSFER: '취득원가 이월 이체',
  SELF_TRANSFER: '본인 계정 간 이동',
}[value] ?? '거래 분류 확인 필요')

const presentBasisMode = (value: string) => ({
  ACTUAL_TOTAL_AVERAGE: '실제 원가 기준',
  DEEMED_EXPENSE_50: '50% 필요경비 특례',
}[value] ?? '원가 기준 확인 필요')

const presentReviewStatus = (value: string) => value === 'CLEAR'
  ? '추가 확인 없음'
  : '사용자 확인 필요'

const presentCoverage = (status: string, assurance?: string) => {
  const completeness = status === 'COMPLETE'
    ? '확인된 전체 기간'
    : status === 'PARTIAL'
      ? '일부 기간 확인'
      : '범위 확인 필요'
  const verification = assurance === 'DOCUMENT_METADATA_VERIFIED'
    ? '원본 자료 확인됨'
    : assurance === 'CHAIN_VERIFIED'
      ? '체인 기록 확인됨'
      : assurance === 'USER_DECLARED'
        ? '사용자 제공 범위'
        : '확인 수준 미확정'
  return `${completeness} · ${verification}`
}

const reportRowAccountLabel = (
  account: NonNullable<ReportPrintModelV1['v2']>['disposals'][number]['account'],
) => {
  const kind = {
    CEX: '거래소 계정',
    EVM_WALLET: '개인 지갑',
    WALLET: '개인 지갑',
  }[account.accountKind ?? ''] ?? '계정 정보 확인 필요'
  return [kind, account.displayName].filter((value): value is string => value !== null)
    .join(' · ') || '계정 정보 확인 필요'
}

export const formatCostMethod = (value: string) => {
  switch (value) {
    case 'ANNUAL_TOTAL_AVERAGE':
      return '연간 총평균법'
    case 'MOVING_AVERAGE':
      return '이동평균법'
    case 'FIFO':
      return '선입선출법'
    default:
      return '원가 계산 방식 확인 필요'
  }
}

const formatPoolScope = (value: string) => {
  switch (value) {
    case 'RESIDENT_TAX_YEAR_TAX_ASSET':
      return '거주자 × 과세연도 × 과세자산'
    case 'ADDRESS':
      return '주소별'
    default:
      return '계산 대상 확인 필요'
  }
}

const formatCalculationContract = (value: string) => {
  switch (value) {
    case 'ANNUAL_TOTAL_AVERAGE':
      return '원가 방식: 연간 총평균법'
    case 'LEGACY':
      return '원가 방식: 기존 주소별 방식'
    case 'UNSUPPORTED':
      return '원가 방식 확인 필요'
    default:
      return '원가 방식 확인 필요'
  }
}

const formatRate = (value: ReportPrintCalculationRateV1) =>
  value.denominator === '100'
    ? `${value.numerator}%`
    : `${value.numerator}/${value.denominator}`

const formatRounding = (value: string) => {
  switch (value) {
    case 'FLOOR':
      return '원 단위 미만 절사'
    case 'FLOOR_EXCEPT_EXHAUSTED_LAYER':
      return '소진 원가층을 제외하고 절사'
    case 'CUMULATIVE_FLOOR_ANNUAL_POOL':
      return '연간 총평균 기준 누적 배분 후 절사'
    case 'MIXED':
      return '여러 반올림 기준 적용'
    default:
      return '반올림 기준 확인 필요'
  }
}

const hasUnknownReportAmounts = (model: ReportPrintModelV1) => [
  model.summary.gainLoss,
  model.summary.taxableBase,
  model.summary.nationalTax,
  model.summary.localTax,
  model.summary.totalTax,
  ...Object.values(model.totals),
  ...model.assetSummaries.flatMap((asset) => [
    asset.grossProceeds,
    asset.acquisitionCost,
    asset.ancillaryExpense,
    asset.gainLoss,
  ]),
  ...model.disposals.flatMap((disposal) => [
    disposal.grossProceeds,
    disposal.basis,
    disposal.ancillaryExpense,
    disposal.gainLoss,
  ]),
  ...model.transfers.map((transfer) => transfer.basis),
].some((amount) => amount.status === 'UNKNOWN')

export const reportDocumentPresentation = (model: ReportPrintModelV1) => {
  const filingReady =
    model.taxYear >= 2027 &&
    model.taxYearCloseStatus === 'CLOSED' &&
    model.finality === 'FINAL' &&
    model.status === 'FINAL' &&
    model.filingStatus === 'READY' &&
    model.summary.calculationContract === 'ANNUAL_TOTAL_AVERAGE' &&
    model.summary.calculationRule?.deductionUsedAmount !== undefined &&
    model.counts.limitations === 0 &&
    model.limitations.length === 0 &&
    !hasUnknownReportAmounts(model)

  if (filingReady) {
    return {
      kind: '신고 준비 자료',
      title: `${model.taxYear}년 가상자산 신고 준비 자료`,
      description:
        '확정된 계산 결과와 제한사항을 함께 정리한 자료입니다. 실제 신고 제출 또는 세무서 접수 완료를 뜻하지 않습니다.',
    } as const
  }
  if (model.taxYear < 2027) {
    return {
      kind: '정책 시뮬레이션 검토 자료',
      title: `${model.taxYear}년 가상자산 정책 시뮬레이션 검토 자료`,
      description:
        '과세 시행 전 정책을 기준으로 계산한 검토 자료입니다. 원화 단위와 세액 적합성은 별도 검토가 필요하며, 실제 신고 제출 또는 세무서 접수 완료를 뜻하지 않습니다.',
    } as const
  }
  if (model.summary.calculationContract !== 'ANNUAL_TOTAL_AVERAGE') {
    return {
      kind: '검토 자료',
      title: `${model.taxYear}년 가상자산 세금 계산 검토 자료`,
      description:
        '총평균법 원가 방식이 확인되지 않아 검토가 필요한 자료입니다. 원화 단위와 세액 적합성은 별도 검토가 필요하며, 실제 신고 제출 또는 세무서 접수 완료를 뜻하지 않습니다.',
    } as const
  }
  return {
    kind: '검토 자료',
    title: `${model.taxYear}년 가상자산 세금 계산 검토 자료`,
    description:
      '잠정 계산, 미확정 금액 또는 보완할 항목이 있는 검토 자료입니다. 신고에 사용하기 전에 제한사항과 원화 단위·세액 적합성을 별도로 확인해야 합니다.',
  } as const
}

const finalityLabel = (value: ReportPrintModelV1['finality']) =>
  value === 'FINAL'
    ? '가격 자료 확정'
    : '가격 자료 잠정'

const taxYearCloseLabel = (
  value: ReportPrintModelV1['taxYearCloseStatus'],
) => value === 'CLOSED'
  ? '연간 입력 마감 확인'
  : '연간 입력 마감 미확인'

const reportStatusLabel = (value: ReportPrintModelV1['status']) =>
  value === 'FINAL'
    ? '계산 항목 확정'
    : '일부 계산 항목 미확정'

const filingStatusLabel = (value: ReportPrintModelV1['filingStatus']) =>
  value === 'READY'
    ? '신고 준비 완료'
    : '신고 전 확인 필요'

export const reportStatusKeyValues = (
  model: ReportPrintModelV1,
): Array<readonly [string, string]> => {
  const presentation = reportDocumentPresentation(model)
  const values: Array<readonly [string, string]> = [
    ['평가 입력', finalityLabel(model.finality)],
    ['연간 마감', taxYearCloseLabel(model.taxYearCloseStatus)],
    ['결과 완결성', reportStatusLabel(model.status)],
    ['신고 준비 상태', filingStatusLabel(model.filingStatus)],
    ['현재 용도', presentation.kind],
    ['제한사항', `${model.limitations.length}건`],
    ['별도 확인', '원화 단위와 세액 적합성'],
  ]
  if (model.v2) {
    values.splice(4, 0,
      ['계산 상태', model.v2.calculationStatus === 'COMPLETE' ? '계산 완료' : '계산 보류'],
      ['세금 결과', model.v2.taxOutcome.includes('ZERO') ? '세액 없음 또는 추정 세액 없음' : model.v2.taxOutcome.includes('DUE') ? '예상 세액 있음' : '계산 근거 확인 필요'],
      ['신고 조치', model.v2.filingAction === 'FILING_NOT_APPLICABLE' ? '신고 대상 아님' : model.v2.filingAction === 'BLOCKED' ? '신고용 계산 보류' : '자료 검토 필요'],
      ['신고 제출 상태', model.v2.filingSubmissionStatus === 'NOT_APPLICABLE' ? '시뮬레이션 장부' : '제출 여부는 이 장부에서 확인하지 않음'],
    )
  }
  return values
}

type CalculationSource = Pick<
  ReportPrintModelV1,
  'summary' | 'denominationAssetId' | 'denominationAtomicDecimals'
>

export const reportCalculationKeyValues = (
  model: CalculationSource,
): Array<readonly [string, string]> => {
  const rows: Array<readonly [string, string]> = []
  if (model.summary.calculationContract !== undefined) {
    rows.push([
      '원가 방식 판정',
      formatCalculationContract(model.summary.calculationContract),
    ])
  }
  if (model.summary.calculationRule === undefined) return rows

  const rule = model.summary.calculationRule
  rows.push(
    ['계산 범위', formatPoolScope(rule.poolScope)],
    [
      '취득원가 계산 방식',
      rule.costMethods.map(formatCostMethod).join(', ') ||
        '제공된 방식 없음',
    ],
    [
      '기본공제',
      formatReportAmountWithScale(
        { status: 'KNOWN', amount: rule.basicDeductionAmount },
        model.denominationAssetId,
        model.denominationAtomicDecimals ?? undefined,
      ),
    ],
  )
  if (rule.deductionUsedAmount !== undefined) {
    rows.push([
      '실제 적용 공제',
      formatReportAmountWithScale(
        { status: 'KNOWN', amount: rule.deductionUsedAmount },
        model.denominationAssetId,
        model.denominationAtomicDecimals ?? undefined,
      ),
    ])
  }
  rows.push(
    ['국세율', formatRate(rule.nationalRate)],
    ['지방세율', formatRate(rule.localRate)],
    ['세액 반올림', formatRounding(rule.taxRounding)],
  )
  if (rule.basisAllocationRounding !== '') {
    rows.push([
      '취득원가 배분 반올림',
      formatRounding(rule.basisAllocationRounding),
    ])
  }
  return rows
}

const asDate = (value: string) => {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error('Report issuedAt must be a valid ISO date-time')
  }
  return parsed
}

export async function renderTaxReportPdf(
  model: ReportPrintModelV1,
  options: RenderOptions,
): Promise<Buffer> {
  const issuedAt = asDate(model.issuedAt)
  const presentation = reportDocumentPresentation(model)
  const documentTitle = presentation.title
  const rendererVersion = options.rendererVersion ?? '1'
  const formatReportAmount = (
    amount: ReportPrintAmountV1,
    denominationAssetId: string,
  ) => formatReportAmountWithScale(
    amount,
    denominationAssetId,
    model.denominationAtomicDecimals ?? undefined,
  )
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: documentTitle,
      Author: 'Daejang',
      Subject: '가상자산 세금 계산 자료',
      Creator: 'Daejang',
      Producer: `daejang-tax-report-pdf/${rendererVersion}`,
      CreationDate: issuedAt,
      ModDate: issuedAt,
    },
    lang: 'ko-KR',
    tagged: true,
  })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  doc.registerFont('Pretendard', options.fontBytes)
  doc.font('Pretendard')

  const contentWidth = page.width - page.marginX * 2
  let addedPageCount = 0

  const addPage = (continuedTitle?: string) => {
    addedPageCount += 1
    doc.addPage({
      size: 'A4',
      margins: {
        top: page.top,
        right: page.marginX,
        // Content still stops at page.bottom through ensureSpace(). A smaller
        // PDFKit margin lets us draw the footer in the reserved band without
        // PDFKit silently creating a new page for each footer text fragment.
        bottom: 0,
        left: page.marginX,
      },
    })
    doc.save()
    if (addedPageCount === 1) {
      doc.font('Pretendard').fillColor(colors.muted).fontSize(7.5)
      doc.text(
        `DAEJANG · ${documentTitle}`,
        page.marginX,
        26,
        { width: contentWidth * 0.62, lineBreak: false },
      )
      doc.text('가상자산 세금 장부', page.marginX + contentWidth * 0.62, 26, {
        align: 'right', width: contentWidth * 0.38, lineBreak: false,
      })
    }
    doc.moveTo(page.marginX, 42)
      .lineTo(page.width - page.marginX, 42)
      .strokeColor(colors.line)
      .lineWidth(0.6)
      .stroke()
    doc.restore()
    doc.y = page.top
    if (continuedTitle) {
      doc.fillColor(colors.ink).fontSize(13)
        .text(`${continuedTitle} · 계속`, page.marginX, doc.y)
      doc.y += 10
    }
  }

  const ensureSpace = (height: number, continuedTitle?: string) => {
    if (doc.y + height <= page.height - page.bottom) return
    addPage(continuedTitle)
  }

  const sectionTitle = (title: string, description?: string) => {
    ensureSpace(description ? 48 : 34)
    doc.fillColor(colors.ink).fontSize(14).text(title, page.marginX, doc.y)
    if (description) {
      doc.moveDown(0.35)
      doc.fillColor(colors.muted).fontSize(8.5)
        .text(description, page.marginX, doc.y, { width: contentWidth })
    }
    doc.moveDown(0.8)
  }

  const drawKeyValues = (
    values: ReadonlyArray<readonly [string, string]>,
    continuedTitle?: string,
  ) => {
    const labelWidth = 122
    for (const [label, value] of values) {
      doc.font('Pretendard').fontSize(8)
      const valueWidth = contentWidth - labelWidth - 18
      const valueHeight = doc.heightOfString(value, {
        width: valueWidth,
        align: 'right',
      })
      const rowHeight = Math.max(25, valueHeight + 12)
      ensureSpace(rowHeight + 2, continuedTitle)
      const rowY = doc.y
      doc.rect(page.marginX, rowY, contentWidth, rowHeight)
        .fillAndStroke(colors.soft, colors.line)
      doc.fillColor(colors.muted).fontSize(8)
        .text(label, page.marginX + 9, rowY + 7, {
          width: labelWidth - 18,
          lineBreak: false,
        })
      doc.fillColor(colors.ink).fontSize(8)
        .text(value, page.marginX + labelWidth, rowY + 6, {
          width: valueWidth,
          height: rowHeight - 10,
          align: 'right',
        })
      doc.y = rowY + rowHeight
    }
    doc.moveDown(0.6)
  }

  const drawTableHeader = (
    columns: ReadonlyArray<CellColumn>,
    y: number,
  ) => {
    doc.rect(page.marginX, y, contentWidth, 24)
      .fillAndStroke(colors.soft, colors.line)
    let x = page.marginX
    for (const column of columns) {
      doc.fillColor(colors.muted).fontSize(7.2)
        .text(column.header, x + 5, y + 8, {
          width: column.width - 10,
          align: column.align ?? 'left',
          lineBreak: false,
        })
      x += column.width
    }
    return y + 24
  }

  const drawTable = ({ title, emptyLabel, columns, rows }: TableOptions) => {
    // Keep the section heading with either its empty state or the first table
    // header/row. This prevents an orphaned heading at the bottom of a page.
    ensureSpace(rows.length === 0 ? 90 : 82)
    sectionTitle(title)
    if (rows.length === 0) {
      doc.rect(page.marginX, doc.y, contentWidth, 42)
        .fillAndStroke(colors.soft, colors.line)
      doc.fillColor(colors.muted).fontSize(8.5)
        .text(emptyLabel, page.marginX + 10, doc.y + 15, {
          width: contentWidth - 20,
          align: 'center',
        })
      doc.y += 52
      return
    }

    let rowY = drawTableHeader(columns, doc.y)
    for (const row of rows) {
      doc.fontSize(7.2)
      const cellHeights = row.map((value, index) => {
        const column = columns[index]
        if (!column) return 0
        return doc.heightOfString(value, {
          width: column.width - 10,
          align: column.align ?? 'left',
        })
      })
      const rowHeight = Math.max(24, ...cellHeights.map((height) => height + 12))
      if (rowY + rowHeight > page.height - page.bottom) {
        addPage(title)
        rowY = drawTableHeader(columns, doc.y)
      }
      doc.rect(page.marginX, rowY, contentWidth, rowHeight)
        .strokeColor(colors.line)
        .lineWidth(0.4)
        .stroke()
      let x = page.marginX
      row.forEach((value, index) => {
        const column = columns[index]
        if (!column) return
        doc.fillColor(colors.ink).fontSize(7.2)
          .text(value, x + 5, rowY + 6, {
            width: column.width - 10,
            height: rowHeight - 10,
            align: column.align ?? 'left',
          })
        x += column.width
      })
      rowY += rowHeight
    }
    doc.y = rowY + 12
  }

  addPage()
  doc.fillColor(colors.accent).fontSize(9)
    .text(presentation.kind, page.marginX, doc.y)
  doc.moveDown(0.65)
  doc.fillColor(colors.ink).fontSize(25)
    .text(documentTitle, {
      width: contentWidth,
    })
  doc.moveDown(0.45)
  doc.fillColor(colors.muted).fontSize(9)
    .text(presentation.description, page.marginX, doc.y, {
      width: contentWidth,
    })
  doc.moveDown(1)

  drawKeyValues([
    ['과세연도', String(model.taxYear)],
    ['생성 시각', formatKstTimestamp(model.issuedAt)],
  ])

  sectionTitle(
    '자료 상태',
    '아래 상태는 현재 장부에 반영된 계산과 원본 자료의 확인 수준입니다. 실제 신고 제출 완료를 뜻하지 않습니다.',
  )
  drawKeyValues(reportStatusKeyValues(model))

  sectionTitle('장부 계산 요약')
  drawKeyValues([
    ['총 처분가액', formatReportAmount(model.totals.grossProceeds, model.denominationAssetId)],
    ['총 취득원가', formatReportAmount(model.totals.acquisitionCost, model.denominationAssetId)],
    ['총 필요경비', formatReportAmount(model.totals.ancillaryExpense, model.denominationAssetId)],
    ['양도손익', formatReportAmount(model.totals.gainLoss, model.denominationAssetId)],
  ])

  sectionTitle('세금 추정 요약')
  drawKeyValues([
    ['연간 손익', formatReportAmount(model.summary.gainLoss, model.denominationAssetId)],
    ['과세표준', formatReportAmount(model.summary.taxableBase, model.denominationAssetId)],
    ['국세', formatReportAmount(model.summary.nationalTax, model.denominationAssetId)],
    ['지방세', formatReportAmount(model.summary.localTax, model.denominationAssetId)],
    ['예상 총 세액', formatReportAmount(model.summary.totalTax, model.denominationAssetId)],
  ])

  if (model.v2) {
    sectionTitle(
      '연간 데이터 포함 범위',
      '과세기간은 1월 1일부터 12월 31일까지이며, 아래 범위는 현재 계산에 실제로 포함된 원천 데이터와 누락 구간입니다.',
    )
    drawKeyValues([
      ['과세기간', `${formatKstTimestamp(model.v2.inputPeriod.from)} ~ ${formatKstTimestamp(model.v2.inputPeriod.through)}`],
      ['표시 경계', `${formatKstTimestamp(model.v2.dataCoverage.from)} ~ ${formatKstTimestamp(model.v2.dataCoverage.through)}`],
      ['포함 상태', presentCoverage(model.v2.dataCoverage.status, model.v2.dataCoverage.assurance)],
      ['계산 기준 시각', formatKstTimestamp(model.v2.calculatedAsOf)],
      [
        '누락 구간',
        model.v2.dataCoverage.uncoveredIntervals.length === 0
          ? '없음'
          : model.v2.dataCoverage.uncoveredIntervals
              .map((row) => `${formatKstTimestamp(row.from)} ~ ${formatKstTimestamp(row.through)}`)
              .join('\n'),
      ],
    ], '연간 데이터 포함 범위')

    drawTable({
      title: '원천별 포함·누락 구간',
      emptyLabel: '원천별 coverage 기록이 없습니다.',
      columns: [
        { header: '원천 / 확인 수준', width: 122 },
        { header: '포함 구간', width: 194 },
        { header: '누락 구간', width: 195 },
      ],
      rows: model.v2.sourceCoverage.map((source) => [
        `${source.systemName ?? '자료 출처'}\n${presentCoverage(source.status, source.assurance)}`,
        source.coveredIntervals.length === 0
          ? '확인된 구간 없음'
          : source.coveredIntervals.map((row) =>
              `${formatKstTimestamp(row.from)} ~ ${formatKstTimestamp(row.through)}`,
            ).join('\n'),
        source.uncoveredIntervals.length === 0
          ? '없음'
          : source.uncoveredIntervals.map((row) =>
              `${formatKstTimestamp(row.from)} ~ ${formatKstTimestamp(row.through)}`,
            ).join('\n'),
      ]),
    })

    sectionTitle('소득과 세액 구성')
    drawKeyValues([
      ['총 처분가액', formatReportAmount(model.v2.summary.grossProceeds, model.denominationAssetId)],
      ['총 취득가액(처분 취득원가)', formatReportAmount(model.v2.summary.disposedBasis, model.denominationAssetId)],
      ['총 필요경비', formatReportAmount(model.v2.summary.deductibleExpense, model.denominationAssetId)],
      ['원천 실제 발생비용', formatReportAmount(model.v2.summary.incurredExpense, model.denominationAssetId)],
      ['처분 손익', formatReportAmount(model.v2.summary.disposalGainLoss, model.denominationAssetId)],
      ['대여소득', formatReportAmount(model.v2.summary.lendingIncome, model.denominationAssetId)],
      ['대여 필요경비', formatReportAmount(model.v2.summary.lendingExpense, model.denominationAssetId)],
      ['대여 순소득', formatReportAmount(model.v2.summary.netLendingIncome, model.denominationAssetId)],
      ['과세소득', formatReportAmount(model.v2.summary.taxableIncome, model.denominationAssetId)],
    ])
  }

  drawTable({
    title: '검토·보완할 항목',
    emptyLabel: '확인된 제한사항이 없습니다.',
    columns: [
      { header: '확인할 내용', width: 112 },
      { header: '설명', width: 236 },
      { header: '영향 대상', width: 163 },
    ],
    rows: model.limitations.map((row) => {
      const targets = row.taxAssetId === undefined
        ? '전체 계산'
        : `${presentTaxAsset(row.taxAssetId)} 자산`
      const [title, description] = presentLimitation(row.code)
      return [title, description, targets]
    }),
  })

  drawTable({
    title: '자산별 계산 요약',
    emptyLabel: '기록된 처분 자산이 없습니다.',
    columns: [
      { header: '자산 / 처분', width: 92 },
      { header: '처분가액', width: 88, align: 'right' },
      { header: '취득원가', width: 88, align: 'right' },
      { header: '필요경비', width: 78, align: 'right' },
      { header: '손익', width: 82, align: 'right' },
      { header: '수량', width: 83, align: 'right' },
    ],
    rows: model.assetSummaries.map((row) => [
      `${presentTaxAsset(row.taxAssetId)}\n${row.disposalCount}건`,
      formatReportAmount(row.grossProceeds, model.denominationAssetId),
      formatReportAmount(row.acquisitionCost, model.denominationAssetId),
      formatReportAmount(row.ancillaryExpense, model.denominationAssetId),
      formatReportAmount(row.gainLoss, model.denominationAssetId),
      formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals),
    ]),
  })

  if (model.v2) {
    drawTable({
      title: '처분 데이터·평가 근거',
      emptyLabel: '기록된 처분 데이터 근거가 없습니다.',
      columns: [
        { header: '거래일시 / 유형', width: 112 },
        { header: '계정', width: 122 },
        { header: '평가 근거', width: 122 },
        { header: '원본 결합 / 검토', width: 155 },
      ],
      rows: model.v2.disposals.map((row) => [
        `${formatKstTimestamp(row.occurredAt)}\n${presentTransactionType(row.transactionType)}`,
        reportRowAccountLabel(row.account),
        row.valuation.status === 'UNKNOWN'
          ? '평가 미확정'
          : `${row.valuation.kind ?? '평가 방식 확인 필요'}\n${row.valuation.effectiveAt ? formatKstTimestamp(row.valuation.effectiveAt) : '시점 미확인'}\n${row.valuation.provider ?? '가격 제공처 확인 필요'} · ${row.valuation.datasetVersion ?? '데이터셋 확인 필요'} · ${formatValuationMarket(row.valuation)}`,
        `${reportRowSourceLabel(row)}\n${presentReviewStatus(row.review.status)}${row.basisEvidenceDigest === null ? '' : '\n50% 필요경비 근거 연결됨'}`,
      ]),
    })

    drawTable({
      title: '자산별 연간 총평균 근거',
      emptyLabel: '기록된 자산별 총평균 근거가 없습니다.',
      columns: [
        { header: '자산 / 원가 기준', width: 108 },
        { header: '취득원가 합계', width: 108, align: 'right' },
        { header: '취득 수량', width: 108, align: 'right' },
        { header: '평균 취득단가', width: 100, align: 'right' },
        { header: '반올림', width: 87 },
      ],
      rows: model.v2.assetSummaries.map((row) => [
        `${presentTaxAsset(row.taxAssetId)}\n${presentBasisMode(row.basisMode)}`,
        row.annualAverage.status === 'NOT_APPLICABLE'
          ? '해당 없음(50% 특례)'
          : row.annualAverage.numerator === null ? '미확정' : formatReportAmount({ status: 'KNOWN', amount: row.annualAverage.numerator }, model.denominationAssetId),
        row.annualAverage.status === 'NOT_APPLICABLE'
          ? '해당 없음(50% 특례)'
          : row.annualAverage.denominator === null ? '미확정' : formatAssetQuantity(row.annualAverage.denominator, row.taxAssetId, row.assetAtomicDecimals),
        row.annualAverage.status === 'NOT_APPLICABLE'
          ? '해당 없음(50% 특례)'
          : row.annualAverage.unitCost === null ? '미확정' : formatReportAmount({ status: 'KNOWN', amount: row.annualAverage.unitCost }, model.denominationAssetId),
        row.annualAverage.status === 'NOT_APPLICABLE'
          ? '해당 없음'
          : row.annualAverage.rounding === null ? '기록 없음' : formatRounding(row.annualAverage.rounding),
      ]),
    })

    const deemedEvidence = deemedExpenseEvidenceRows(model)
    if (deemedEvidence.length > 0) {
      drawTable({
        title: '50% 필요경비 특례 증거',
        emptyLabel: '50% 필요경비 특례를 적용한 자산이 없습니다.',
        columns: [
          { header: '자산', width: 66 },
          { header: '법정 적용 사유', width: 130 },
          { header: '원본 근거', width: 315 },
        ],
        rows: deemedEvidence,
      })
    }

    drawTable({
      title: '기초가액 적용 근거',
      emptyLabel: '기록된 기초가액 근거가 없습니다.',
      columns: [
        { header: '자산 / 확인 상태', width: 108 },
        { header: '적용 규칙', width: 125 },
        { header: '실제취득가', width: 102, align: 'right' },
        { header: '2026년 말 시가', width: 102, align: 'right' },
        { header: '이전 확정 장부', width: 76 },
      ],
      rows: model.v2.assetSummaries.map((row) => [
        `${presentTaxAsset(row.taxAssetId)}\n${row.openingBasisProvenance.status === 'KNOWN' ? '확인됨' : row.openingBasisProvenance.status === 'NOT_APPLICABLE' ? '해당 없음' : '확인 필요'}`,
        row.openingBasisProvenance.basisRule === 'ACTUAL_ACQUISITION' ? '실제 취득가액 기준' : row.openingBasisProvenance.basisRule === 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET' ? '실제 취득가액과 기준일 시가 중 높은 금액' : row.openingBasisProvenance.basisRule === 'PRIOR_FINAL_RUN' ? '이전 확정 장부의 기초가액' : '해당 없음',
        row.openingBasisProvenance.actualAcquisitionAmount === null
          ? '해당 없음'
          : formatReportAmount(
            { status: 'KNOWN', amount: row.openingBasisProvenance.actualAcquisitionAmount },
            model.denominationAssetId,
          ),
        row.openingBasisProvenance.marketValueAt2026End === null
          ? '해당 없음'
          : formatReportAmount(
            { status: 'KNOWN', amount: row.openingBasisProvenance.marketValueAt2026End },
            model.denominationAssetId,
          ),
        row.openingBasisProvenance.sourceRunId === null ? '해당 없음' : '이전 확정 장부에 연결됨',
      ]),
    })
  }

  drawTable({
    title: '처분별 장부',
    emptyLabel: '기록된 처분 항목이 없습니다.',
    columns: [
      { header: '자산 / 수량', width: 92 },
      { header: '처분가액', width: 88, align: 'right' },
      { header: '취득원가', width: 88, align: 'right' },
      { header: '필요경비', width: 78, align: 'right' },
      { header: '손익', width: 82, align: 'right' },
      { header: '근거', width: 83 },
    ],
    rows: model.disposals.map((row) => [
      `${presentTaxAsset(row.taxAssetId)}\n${formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals)}`,
      formatReportAmount(row.grossProceeds, model.denominationAssetId),
      formatReportAmount(row.basis, model.denominationAssetId),
      formatReportAmount(row.ancillaryExpense, model.denominationAssetId),
      formatReportAmount(row.gainLoss, model.denominationAssetId),
      `${formatCostMethod(row.costMethod)}\n원본 거래 자료에 연결됨`,
    ]),
  })

  if (model.v2) {
    drawTable({
      title: '가상자산 수수료 별도 처분',
      emptyLabel: '가상자산으로 지급한 별도 수수료 처분이 없습니다.',
      columns: [
        { header: '자산 / 수량', width: 95 },
        { header: '처분가액', width: 90, align: 'right' },
        { header: '원가', width: 90, align: 'right' },
        { header: '손익', width: 90, align: 'right' },
        { header: '원가 기준 / 원본 근거', width: 146 },
      ],
      rows: model.v2.feeAssetDisposals.map((row) => [
        `${formatKstTimestamp(row.occurredAt)}\n${formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals)}`,
        formatReportAmount(row.grossProceeds, model.denominationAssetId),
        formatReportAmount(row.basis, model.denominationAssetId),
        formatReportAmount(row.gainLoss, model.denominationAssetId),
        `${presentBasisMode(row.basisMode)}\n${reportRowSourceLabel(row)}\n${presentReviewStatus(row.review.status)}${row.basisEvidenceDigest === null ? '' : '\n50% 필요경비 근거 연결됨'}`,
      ]),
    })

    drawTable({
      title: '대여소득과 보상자산 취득',
      emptyLabel: '기록된 대여소득 또는 보상자산 취득이 없습니다.',
      columns: [
        { header: '구분', width: 112 },
        { header: '자산 / 수량', width: 112 },
        { header: '원화 금액 구성', width: 112, align: 'right' },
        { header: '계정 / 원본 근거', width: 175 },
      ],
      rows: [
        ...model.v2.incomeRows.map((row) => [
          `${formatKstTimestamp(row.occurredAt)}\n${presentTransactionType(row.transactionType)}`,
          `${presentTaxAsset(row.taxAssetId)}\n${formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals)}`,
          formatReportAmount(row.income, model.denominationAssetId),
          `${reportRowAccountLabel(row.account)}\n${reportRowSourceLabel(row)}\n${presentReviewStatus(row.review.status)}`,
        ]),
        ...model.v2.acquisitions.map((row) => [
          `${formatKstTimestamp(row.occurredAt)}\n${presentTransactionType(row.transactionType)}`,
          `${presentTaxAsset(row.taxAssetId)}\n${formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals)}`,
          [
            `취득대금 ${formatReportAmount(row.consideration, model.denominationAssetId)}`,
            `취득수수료 ${formatReportAmount(row.acquisitionAncillaryExpense, model.denominationAssetId)}`,
            `총취득가액 ${formatReportAmount(row.acquisitionCost, model.denominationAssetId)}`,
          ].join('\n'),
          [
            reportRowAccountLabel(row.account),
            reportRowSourceLabel(row),
            presentReviewStatus(row.review.status),
            ...incomePolicyMappingLines(row.incomePolicyMapping),
          ].join('\n'),
        ]),
      ],
    })

    drawTable({
      title: '비과세 자기이체 데이터 근거',
      emptyLabel: '기록된 비과세 자기이체가 없습니다.',
      columns: [
        { header: '거래일시 / 자산', width: 122 },
        { header: '출발 계정', width: 122 },
        { header: '도착 계정', width: 122 },
        { header: '원본 결합 / 검토', width: 143 },
      ],
      rows: model.v2.nonTaxableTransfers.map((row) => [
        `${formatKstTimestamp(row.occurredAt)}\n${formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals)}`,
        reportRowAccountLabel(row.from),
        reportRowAccountLabel(row.to),
        `${reportRowSourceLabel(row)}\n${presentReviewStatus(row.review.status)}`,
      ]),
    })
  }

  drawTable({
    title: '자기이체',
    emptyLabel: '기록된 자기이체가 없습니다.',
    columns: [
      { header: '자산', width: 82 },
      { header: '수량', width: 102, align: 'right' },
      { header: '이전 원가', width: 104, align: 'right' },
      { header: '원가 방식', width: 112 },
      { header: '근거', width: 111 },
    ],
    rows: model.transfers.map((row) => [
      presentTaxAsset(row.taxAssetId),
      formatAssetQuantity(row.quantity, row.taxAssetId, row.assetAtomicDecimals),
      formatReportAmount(row.basis, model.denominationAssetId),
      `${formatCostMethod(row.fromCostMethod)} → ${formatCostMethod(row.toCostMethod)}`,
      '원본 거래 자료에 연결됨',
    ]),
  })

  drawTable({
    title: '과세 제외 전환',
    emptyLabel: '기록된 과세 제외 전환이 없습니다.',
    columns: [
      { header: '자산', width: 86 },
      { header: '전환 전 수량', width: 112, align: 'right' },
      { header: '전환 후 수량', width: 112, align: 'right' },
      { header: '근거', width: 201 },
    ],
    rows: model.excludedConversions.map((row) => [
      presentTaxAsset(row.taxAssetId),
      '수량 단위 확인 필요',
      '수량 단위 확인 필요',
      '원본 거래 자료에 연결됨',
    ]),
  })

  const calculationRows = reportCalculationKeyValues(model)
  if (calculationRows.length > 0) {
    sectionTitle(
      '적용 계산 기준',
      '이 자료에 적용된 계산 기준을 표시합니다.',
    )
    drawKeyValues(calculationRows, '적용 계산 기준')
  }

  if (model.v2) {
    sectionTitle(
      '적용 정책과 법령 근거',
      '이 계산에 적용된 정책 기간과 법령 근거입니다.',
    )
    drawKeyValues([
      ['정책 적용', model.v2.policy.applicationMode === 'ENACTED' ? '시행 기준' : '시뮬레이션 기준'],
      ['정책 적용기간', `${formatKstTimestamp(model.v2.policy.effectiveFrom)} ~ ${formatKstTimestamp(model.v2.policy.effectiveThrough)}`],
      [
        '신고용 반올림 기준',
        model.v2.policy.roundingProfileStatus === 'APPROVED'
          ? '승인됨'
          : '승인 전 · 현재 세액은 추정치',
      ],
      ...model.v2.policy.legalReferences.map((reference) => [
        `${reference.law} ${reference.article}${reference.paragraphs.length ? ` ${reference.paragraphs.join(', ')}` : ''}`,
        [
          reference.purpose,
          ...reference.sourceLocators,
          reference.sourceCheckedAt === null
            ? null
            : `근거 확인: ${formatKstTimestamp(reference.sourceCheckedAt)}`,
        ].filter((value): value is string => value !== null).join('\n'),
      ] as const),
    ], '적용 정책과 법령 근거')
  }

  ensureSpace(72)
  sectionTitle(
    '원본 근거 확인',
    '거래별 원본 자료와 계산 근거는 장부 화면의 “원본 근거 보기”에서 확인할 수 있습니다.',
  )

  const range = doc.bufferedPageRange()
  for (let pageIndex = range.start; pageIndex < range.start + range.count; pageIndex += 1) {
    doc.switchToPage(pageIndex)
    doc.save()
    doc.fillOpacity(1)
    doc.moveTo(page.marginX, page.height - 38)
      .lineTo(page.width - page.marginX, page.height - 38)
      .strokeColor(colors.line)
      .lineWidth(0.5)
      .stroke()
    doc.fillColor(colors.muted).fontSize(7)
      .text('Daejang 가상자산 세금 장부', page.marginX, page.height - 28, {
        width: contentWidth * 0.72,
        lineBreak: false,
      })
    doc.text(
      `${pageIndex - range.start + 1} / ${range.count}`,
      page.marginX + contentWidth * 0.72,
      page.height - 28,
      {
        width: contentWidth * 0.28,
        align: 'right',
        lineBreak: false,
      },
    )
    doc.restore()
  }

  doc.end()
  return completed
}
