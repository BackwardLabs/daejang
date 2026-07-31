import PDFDocument from 'pdfkit'

import type {
  ReportPrintAmountV1,
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

export const formatReportAmount = (
  amount: ReportPrintAmountV1,
  denominationAssetId: string,
) => amount.status === 'KNOWN'
  ? `${formatDecimal(amount.amount)} ${denominationAssetId}`
  : '—'

const shortId = (value: string) => value.length <= 28
  ? value
  : `${value.slice(0, 12)}…${value.slice(-12)}`

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
  const documentTitle = `${model.taxYear}년 가상자산 세무 장부`
  const rendererVersion = options.rendererVersion ?? '1'
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: documentTitle,
      Author: 'Daejang',
      Subject: `Immutable tax report ${model.reportId}`,
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
    .text('TAX LEDGER', page.marginX, doc.y)
  doc.moveDown(0.65)
  doc.fillColor(colors.ink).fontSize(25)
    .text(documentTitle, {
      width: contentWidth,
    })
  doc.moveDown(0.3)
  doc.moveDown(1)

  drawKeyValues([
    ['과세연도', String(model.taxYear)],
    ['Report ID', model.reportId],
    ['Report model digest', model.reportModelDigest],
    ['생성 시각', model.issuedAt],
  ])

  sectionTitle('장부 계산 요약')
  drawKeyValues([
    ['총 처분가액', formatReportAmount(model.totals.grossProceeds, model.denominationAssetId)],
    ['총 취득원가', formatReportAmount(model.totals.acquisitionCost, model.denominationAssetId)],
    ['총 필요경비', formatReportAmount(model.totals.ancillaryExpense, model.denominationAssetId)],
    ['양도손익', formatReportAmount(model.totals.gainLoss, model.denominationAssetId)],
  ])

  sectionTitle('세금 추정 요약')
  drawKeyValues([
    ['과세표준', formatReportAmount(model.summary.taxableBase, model.denominationAssetId)],
    ['국세', formatReportAmount(model.summary.nationalTax, model.denominationAssetId)],
    ['지방세', formatReportAmount(model.summary.localTax, model.denominationAssetId)],
    ['예상 총 세액', formatReportAmount(model.summary.totalTax, model.denominationAssetId)],
  ])

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
      `${row.costMethod}\n${shortId(row.movementId)}`,
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
      `${row.fromCostMethod} → ${row.toCostMethod}`,
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

  ensureSpace(370)
  sectionTitle(
    '산출 방법과 재현 정보',
    '아래 식별자는 장부 계산에 사용된 정확한 정책과 엔진 실행을 추적하기 위한 정보입니다.',
  )
  drawKeyValues([
    ['Tax inventory run', model.methodology.taxInventoryRunId],
    ['Tax estimate', model.methodology.taxEstimateId],
    ['Lot run', model.methodology.lotRunId],
    ['Generation', model.methodology.generationId],
    ['Schema digest', model.methodology.schemaDigest],
    [
      'Policy',
      `${model.methodology.policy.name} ${model.methodology.policy.version}`,
    ],
    ['Policy artifact digest', model.methodology.policy.artifactDigest],
    [
      'Engine',
      `${model.methodology.engine.name} ${model.methodology.engine.version}`,
    ],
    ['Engine artifact digest', model.methodology.engine.artifactDigest],
    ['Input digest', model.inputDigest],
    ['Evidence pack digest', model.evidencePackDigest],
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
