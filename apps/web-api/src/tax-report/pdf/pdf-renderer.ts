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
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}

const formatAtomicAmount = (value: string, decimals: number) => {
  if (!/^-?\d+$/.test(value)) return formatDecimal(value)
  const negative = value.startsWith('-')
  const digits = negative ? value.slice(1) : value
  const padded = digits.padStart(decimals + 1, '0')
  const integer = padded.slice(0, -decimals)
  const fraction = padded.slice(-decimals).replace(/0+$/, '')
  return formatDecimal(
    `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`,
  )
}

export const formatReportAmount = (
  amount: ReportPrintAmountV1,
  denominationAssetId: string,
) => {
  if (amount.status !== 'KNOWN') return '미확정(0원이 아님)'
  const presentation = reportDenominations[denominationAssetId]
  if (presentation) {
    return `${formatAtomicAmount(
      amount.amount,
      presentation.decimals,
    )} ${presentation.symbol}`
  }
  return `${formatDecimal(amount.amount)} ${denominationAssetId}`
}

const shortId = (value: string) => value.length <= 28
  ? value
  : `${value.slice(0, 12)}…${value.slice(-12)}`

export const formatCostMethod = (value: string) => {
  switch (value) {
    case 'ANNUAL_TOTAL_AVERAGE':
      return '연간 총평균법 (ANNUAL_TOTAL_AVERAGE)'
    case 'MOVING_AVERAGE':
      return '이동평균법 (MOVING_AVERAGE)'
    case 'FIFO':
      return '선입선출법 (FIFO)'
    default:
      return value
  }
}

const formatPoolScope = (value: string) => {
  switch (value) {
    case 'RESIDENT_TAX_YEAR_TAX_ASSET':
      return '거주자 × 과세연도 × 과세자산'
    case 'ADDRESS':
      return '주소별'
    default:
      return value
  }
}

const formatCalculationContract = (value: string) => {
  switch (value) {
    case 'ANNUAL_TOTAL_AVERAGE':
      return '원가 방식: 연간 총평균법 (ANNUAL_TOTAL_AVERAGE)'
    case 'LEGACY':
      return '원가 방식: 기존 주소별 방식 (LEGACY)'
    case 'UNSUPPORTED':
      return '원가 방식 확인 불가 (UNSUPPORTED)'
    default:
      return value
  }
}

const formatRate = (value: ReportPrintCalculationRateV1) =>
  value.denominator === '100'
    ? `${value.numerator}% (${value.numerator}/${value.denominator})`
    : `${value.numerator}/${value.denominator}`

const formatRounding = (value: string) => {
  switch (value) {
    case 'FLOOR':
      return '절사 (FLOOR)'
    case 'FLOOR_EXCEPT_EXHAUSTED_LAYER':
      return '소진 원가층 제외 절사 (FLOOR_EXCEPT_EXHAUSTED_LAYER)'
    case 'CUMULATIVE_FLOOR_ANNUAL_POOL':
      return '연간 총평균 누적 배분 절사 (CUMULATIVE_FLOOR_ANNUAL_POOL)'
    case 'MIXED':
      return '복수 반올림 규칙 (MIXED)'
    default:
      return value
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
        'Tax Engine에서 확정 계산과 차단 항목 없음을 판정한 자료입니다. 원화 단위와 세액 적합성은 별도 검토가 필요하며, 실제 신고 제출 또는 세무서 접수 완료를 뜻하지 않습니다.',
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
    ? 'FINAL · 평가 입력 확정'
    : 'PROVISIONAL · 평가 입력 잠정'

const taxYearCloseLabel = (
  value: ReportPrintModelV1['taxYearCloseStatus'],
) => value === 'CLOSED'
  ? 'CLOSED · 연간 입력 마감 확인'
  : 'UNVERIFIED · 연간 입력 마감 미확인'

const reportStatusLabel = (value: ReportPrintModelV1['status']) =>
  value === 'FINAL'
    ? 'FINAL · 계산 항목 확정'
    : 'PARTIAL · 일부 계산 항목 미확정'

const filingStatusLabel = (value: ReportPrintModelV1['filingStatus']) =>
  value === 'READY'
    ? 'READY · 엔진상 차단 항목 없음'
    : 'BLOCKED · 엔진상 차단 항목 있음'

export const reportStatusKeyValues = (
  model: ReportPrintModelV1,
): Array<readonly [string, string]> => {
  const presentation = reportDocumentPresentation(model)
  return [
    ['평가 입력', finalityLabel(model.finality)],
    ['연간 마감', taxYearCloseLabel(model.taxYearCloseStatus)],
    ['결과 완결성', reportStatusLabel(model.status)],
    ['신고 준비 상태', filingStatusLabel(model.filingStatus)],
    ['현재 용도', presentation.kind],
    ['제한사항', `${model.limitations.length}건`],
    ['별도 확인', '원화 단위와 세액 적합성'],
  ]
}

type CalculationSource = Pick<
  ReportPrintModelV1,
  'summary' | 'denominationAssetId'
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
      formatReportAmount(
        { status: 'KNOWN', amount: rule.basicDeductionAmount },
        model.denominationAssetId,
      ),
    ],
  )
  if (rule.deductionUsedAmount !== undefined) {
    rows.push([
      '실제 적용 공제',
      formatReportAmount(
        { status: 'KNOWN', amount: rule.deductionUsedAmount },
        model.denominationAssetId,
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
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: documentTitle,
      Author: 'Daejang',
      Subject: `Tax calculation reference ${model.reportId}`,
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
      doc.text(
        shortId(model.reportId),
        page.marginX + contentWidth * 0.62,
        26,
        {
          align: 'right',
          width: contentWidth * 0.38,
          lineBreak: false,
        },
      )
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
    ['Report ID', model.reportId],
    ['Report model digest', model.reportModelDigest],
    ['생성 시각', model.issuedAt],
  ])

  sectionTitle(
    '자료 상태',
    '아래 값은 Tax Engine의 계산 상태입니다. 법적·제품 최종 승인이나 신고 완료를 뜻하지 않습니다.',
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

  drawTable({
    title: '검토·보완할 항목',
    emptyLabel: '확인된 제한사항이 없습니다.',
    columns: [
      { header: '코드', width: 112 },
      { header: '설명', width: 236 },
      { header: '영향 대상', width: 163 },
    ],
    rows: model.limitations.map((row) => {
      const targets = [
        row.taxAssetId === undefined ? undefined : `자산 ${row.taxAssetId}`,
        row.taxAddressId === undefined
          ? undefined
          : `주소 ${shortId(row.taxAddressId)}`,
        row.movementId === undefined
          ? undefined
          : `Movement ${shortId(row.movementId)}`,
        row.reviewId === undefined
          ? undefined
          : `Review ${shortId(row.reviewId)}`,
        row.reviewRevisionId === undefined
          ? undefined
          : `Review revision ${shortId(row.reviewRevisionId)}`,
      ].filter((value): value is string => value !== undefined)
      return [row.code, row.reason, targets.join('\n') || '전체 계산']
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
      { header: '최소 단위 수량', width: 83, align: 'right' },
    ],
    rows: model.assetSummaries.map((row) => [
      `${row.taxAssetId}\n${row.disposalCount}건`,
      formatReportAmount(row.grossProceeds, model.denominationAssetId),
      formatReportAmount(row.acquisitionCost, model.denominationAssetId),
      formatReportAmount(row.ancillaryExpense, model.denominationAssetId),
      formatReportAmount(row.gainLoss, model.denominationAssetId),
      formatDecimal(row.quantity),
    ]),
  })

  drawTable({
    title: '처분별 장부',
    emptyLabel: '기록된 처분 항목이 없습니다.',
    columns: [
      { header: '자산 / 최소 단위 수량', width: 92 },
      { header: '처분가액', width: 88, align: 'right' },
      { header: '취득원가', width: 88, align: 'right' },
      { header: '필요경비', width: 78, align: 'right' },
      { header: '손익', width: 82, align: 'right' },
      { header: '근거', width: 83 },
    ],
    rows: model.disposals.map((row) => [
      `${row.taxAssetId}\n${formatDecimal(row.quantity)}`,
      formatReportAmount(row.grossProceeds, model.denominationAssetId),
      formatReportAmount(row.basis, model.denominationAssetId),
      formatReportAmount(row.ancillaryExpense, model.denominationAssetId),
      formatReportAmount(row.gainLoss, model.denominationAssetId),
      `${formatCostMethod(row.costMethod)}\n${shortId(row.movementId)}`,
    ]),
  })

  drawTable({
    title: '자기이체',
    emptyLabel: '기록된 자기이체가 없습니다.',
    columns: [
      { header: '자산', width: 82 },
      { header: '최소 단위 수량', width: 102, align: 'right' },
      { header: '이전 원가', width: 104, align: 'right' },
      { header: '원가 방식', width: 112 },
      { header: '근거', width: 111 },
    ],
    rows: model.transfers.map((row) => [
      row.taxAssetId,
      formatDecimal(row.quantity),
      formatReportAmount(row.basis, model.denominationAssetId),
      `${formatCostMethod(row.fromCostMethod)} → ${formatCostMethod(row.toCostMethod)}`,
      shortId(row.movementId),
    ]),
  })

  drawTable({
    title: '과세 제외 전환',
    emptyLabel: '기록된 과세 제외 전환이 없습니다.',
    columns: [
      { header: '자산', width: 86 },
      { header: '전환 전 최소 단위', width: 112, align: 'right' },
      { header: '전환 후 최소 단위', width: 112, align: 'right' },
      { header: 'Relation', width: 201 },
    ],
    rows: model.excludedConversions.map((row) => [
      row.taxAssetId,
      formatDecimal(row.fromQuantity),
      formatDecimal(row.toQuantity),
      shortId(row.relationId),
    ]),
  })

  const calculationRows = reportCalculationKeyValues(model)
  if (calculationRows.length > 0) {
    sectionTitle(
      '적용 계산 기준',
      'Tax Engine이 이 자료에 함께 제공한 계산 기준만 표시합니다.',
    )
    drawKeyValues(calculationRows, '적용 계산 기준')
  }

  ensureSpace(370)
  sectionTitle(
    '산출 방법과 재현 정보',
    '아래 식별자는 장부 계산에 사용된 정확한 정책과 엔진 실행을 추적하기 위한 정보입니다.',
  )
  drawKeyValues([
    ['세금 장부 실행 ID', model.methodology.taxInventoryRunId],
    ['세액 추정 ID', model.methodology.taxEstimateId],
    ['Lot 실행 ID', model.methodology.lotRunId],
    ['생성 작업 ID', model.methodology.generationId],
    ['스키마 hash', model.methodology.schemaDigest],
    [
      '정책 이름·버전',
      `${model.methodology.policy.name} ${model.methodology.policy.version}`,
    ],
    ['정책 artifact hash', model.methodology.policy.artifactDigest],
    [
      '엔진 이름·버전',
      `${model.methodology.engine.name} ${model.methodology.engine.version}`,
    ],
    ['엔진 artifact hash', model.methodology.engine.artifactDigest],
    ['입력 hash', model.inputDigest],
    ['근거 묶음 hash', model.evidencePackDigest],
  ], '산출 방법과 재현 정보')

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
      .text(
        `Report ID ${shortId(model.reportId)}`,
        page.marginX,
        page.height - 28,
        {
          width: contentWidth * 0.72,
          lineBreak: false,
        },
      )
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
