import {
  deriveMockLedgerResult,
  ledgerRevisionResults,
  readMockLedgerPublication,
  type LedgerTransaction,
} from './ledger.ts'

export type ReportStatus = 'FINAL' | 'PARTIAL'

export type ReportOutput = {
  format: 'csv' | 'evidence' | 'json' | 'manifest' | 'print'
  label: string
}

export type ReportTransactionSummary = {
  occurredAt: string
  source: string
  status: string
  title: string
}

export type ReportSnapshot = {
  attestationUid: string
  commitment: string
  completeCount: number
  exceptionCount: number
  id: string
  issuedAt: string
  issuedDate: string
  manifestId: string
  network: string
  outputs: ReportOutput[]
  outputsConsistent: boolean
  profitWon: number
  revision: string
  snapshotId: string
  status: ReportStatus
  transactionCount: number
  transactionSummaries: ReportTransactionSummary[]
  transactions: LedgerTransaction[]
  verified: boolean
  year: '2026' | '2027'
}

const reportOutputs: ReportOutput[] = [
  { format: 'print', label: 'PDF 요약' },
  { format: 'csv', label: 'CSV 상세' },
  { format: 'json', label: 'JSON ledger' },
  { format: 'manifest', label: 'Manifest' },
  { format: 'evidence', label: 'Evidence Pack' },
]

function buildCurrentReport(
  transactions: LedgerTransaction[],
): ReportSnapshot {
  const ledgerResult = deriveMockLedgerResult(transactions)
  const revision = ledgerResult.revision
  const publication = readMockLedgerPublication()
  const isPublished =
    publication?.revision === revision &&
    publication.profitWon === ledgerResult.profitWon &&
    publication.transactionCount === transactions.length
  const completeCount = transactions.filter(
    (transaction) => transaction.statusCode === 'confirmed',
  ).length
  const exceptionCount = transactions.length - completeCount
  const issuedDate =
    [...transactions]
      .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))[0]
      ?.occurredAt.slice(0, 10) ?? '2027-03-14'

  return {
    attestationUid: '0x41…8db',
    commitment: '0x9c…af31',
    completeCount,
    exceptionCount,
    id: `report-2027-${revision}`,
    issuedAt: isPublished ? publication.publishedAt : '작업 중',
    issuedDate,
    manifestId: `manifest.2027.${revision}`,
    network: 'GIWA Sepolia',
    outputs: reportOutputs,
    outputsConsistent: isPublished,
    profitWon: ledgerResult.profitWon,
    revision,
    snapshotId: `snapshot.2027.${revision}`,
    status: exceptionCount === 0 ? 'FINAL' : 'PARTIAL',
    transactionCount: transactions.length,
    transactionSummaries: transactions.map((transaction) => ({
      occurredAt: transaction.occurredAt,
      source: transaction.source.name,
      status: transaction.status,
      title: transaction.title,
    })),
    transactions,
    verified: isPublished,
    year: '2027',
  }
}

const historicalReports: ReportSnapshot[] = [
  {
    attestationUid: '0x39…be4',
    commitment: '0x84…d710',
    completeCount: 5,
    exceptionCount: 2,
    id: 'report-2027-rev-4-history',
    issuedAt: '2027-03-14 08:44',
    issuedDate: '2027-03-14',
    manifestId: 'manifest.2027.rev.4',
    network: 'GIWA Sepolia',
    outputs: reportOutputs,
    outputsConsistent: true,
    profitWon: ledgerRevisionResults['rev.4'].profitWon,
    revision: 'rev.4',
    snapshotId: 'snapshot.2027.rev.4',
    status: 'PARTIAL',
    transactionCount: 7,
    transactionSummaries: [
      {
        occurredAt: '2027-03-14T09:12:00+09:00',
        source: 'Upbit',
        status: '잠정',
        title: 'BTC 매도',
      },
      {
        occurredAt: '2027-03-12T17:40:00+09:00',
        source: 'Upbit',
        status: '확인됨',
        title: 'ETH 매도',
      },
      {
        occurredAt: '2027-03-10T11:18:00+09:00',
        source: 'Ethereum 지갑',
        status: '검토 필요',
        title: 'ETH 전송',
      },
    ],
    transactions: [],
    verified: true,
    year: '2027',
  },
  {
    attestationUid: '0x37…12c',
    commitment: '0x72…a903',
    completeCount: 6,
    exceptionCount: 1,
    id: 'report-2027-rev-3',
    issuedAt: '2027-03-12 18:20',
    issuedDate: '2027-03-12',
    manifestId: 'manifest.2027.rev.3',
    network: 'GIWA Sepolia',
    outputs: reportOutputs,
    outputsConsistent: true,
    profitWon: ledgerRevisionResults['rev.3'].profitWon,
    revision: 'rev.3',
    snapshotId: 'snapshot.2027.rev.3',
    status: 'PARTIAL',
    transactionCount: 7,
    transactionSummaries: [
      {
        occurredAt: '2027-03-12T17:40:00+09:00',
        source: 'Upbit',
        status: '확인됨',
        title: 'ETH 매도',
      },
      {
        occurredAt: '2027-03-10T11:18:00+09:00',
        source: 'Ethereum 지갑',
        status: '검토 필요',
        title: 'ETH 전송',
      },
    ],
    transactions: [],
    verified: true,
    year: '2027',
  },
  {
    attestationUid: '0x19…77a',
    commitment: '0x51…be22',
    completeCount: 5,
    exceptionCount: 0,
    id: 'report-2026-rev-2',
    issuedAt: '2026-12-31 16:42',
    issuedDate: '2026-12-31',
    manifestId: 'manifest.2026.rev.2',
    network: 'GIWA Sepolia',
    outputs: reportOutputs,
    outputsConsistent: true,
    profitWon: -330_000,
    revision: 'rev.2',
    snapshotId: 'snapshot.2026.rev.2',
    status: 'FINAL',
    transactionCount: 5,
    transactionSummaries: [
      {
        occurredAt: '2026-12-29T14:12:00+09:00',
        source: 'Upbit',
        status: '확인됨',
        title: 'BTC 매도',
      },
    ],
    transactions: [],
    verified: true,
    year: '2026',
  },
]

export function createMockReports(
  transactions: LedgerTransaction[],
): ReportSnapshot[] {
  const currentReport = buildCurrentReport(transactions)

  return [
    currentReport,
    ...historicalReports.filter(
      (report) =>
        report.year !== currentReport.year ||
        report.revision !== currentReport.revision,
    ),
  ]
}

export function formatReportWon(value: number) {
  const sign = value > 0 ? '+' : value < 0 ? '−' : ''

  return `${sign}${Math.abs(value).toLocaleString('ko-KR')}원`
}

export const reportIntegrityNotice =
  '무결성 검증은 발행 후 변조 여부를 보장합니다. 거래 분류·취득원가·세액의 정확성이나 세무 당국의 법적 인정을 보장하지 않습니다.'

export type MockReportShare = {
  access: Array<'evidence_metadata' | 'summary' | 'transaction_summary'>
  createdAt: string
  expiresAt: string
  id: string
  recipientEmail: string
  reportId: string
  url: string
}

export function createMockReportShare({
  expiresInDays,
  recipientEmail,
  report,
}: {
  expiresInDays: number
  recipientEmail: string
  report: ReportSnapshot
}): MockReportShare {
  const createdAt = new Date('2027-07-20T09:03:00+09:00')
  const expiresAt = new Date(createdAt)
  expiresAt.setDate(expiresAt.getDate() + expiresInDays)
  const shareId = `share-${report.year}-${report.revision.replace('.', '-')}`

  return {
    access: ['summary', 'transaction_summary', 'evidence_metadata'],
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    id: shareId,
    recipientEmail,
    reportId: report.id,
    url: `${window.location.origin}/shared/reports/${shareId}`,
  }
}
