import { useMemo, useState, type FormEvent } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { readMockLedgerTransactions } from '../../mocks/ledger.ts'
import {
  createMockReports,
  createMockReportShare,
  formatReportWon,
  reportIntegrityNotice,
  type MockReportShare,
  type ReportOutput,
  type ReportSnapshot,
} from '../../mocks/reports.ts'
import '../ledger/ledger.css'
import './report.css'

function downloadBlob(filename: string, type: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function downloadOutput(output: ReportOutput, report: ReportSnapshot) {
  if (output.format === 'print') {
    window.print()
    return
  }

  const baseName = `daejang-${report.year}-${report.revision.replace('.', '-')}`
  const transactions = report.transactions

  if (output.format === 'csv') {
    const rows = [
      ['id', 'occurredAt', 'title', 'asset', 'source', 'impact', 'status'],
      ...transactions.map((transaction) => [
        transaction.id,
        transaction.occurredAt,
        transaction.title,
        transaction.asset,
        transaction.source.name,
        transaction.impact,
        transaction.status,
      ]),
    ]
    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
          .join(','),
      )
      .join('\n')

    downloadBlob(`${baseName}.csv`, 'text/csv;charset=utf-8', csv)
    return
  }

  const payload =
    output.format === 'evidence'
      ? {
          manifestId: report.manifestId,
          snapshotId: report.snapshotId,
          transactions: transactions.map((transaction) => ({
            journey: transaction.journey,
            reviewTask: transaction.reviewTask,
            transactionId: transaction.id,
          })),
        }
      : output.format === 'manifest'
        ? {
            commitment: report.commitment,
            issuedAt: report.issuedAt,
            manifestId: report.manifestId,
            outputsConsistent: report.outputsConsistent,
            revision: report.revision,
            snapshotId: report.snapshotId,
            transactionCount: report.transactionCount,
          }
        : {
            report: {
              issuedAt: report.issuedAt,
              revision: report.revision,
              status: report.status,
              transactionCount: report.transactionCount,
              year: report.year,
            },
            transactions,
          }

  downloadBlob(
    `${baseName}-${output.format}.json`,
    'application/json',
    JSON.stringify(payload, null, 2),
  )
}

function formatReportStatus(status: ReportSnapshot['status']) {
  return status === 'FINAL' ? '최종 발행' : '예외 포함'
}

function ReportHistoryItem({
  active,
  isCurrent,
  onSelect,
  report,
}: {
  active: boolean
  isCurrent: boolean
  onSelect: () => void
  report: ReportSnapshot
}) {
  return (
    <button
      type="button"
      className={active ? 'is-active' : undefined}
      onClick={onSelect}
    >
      <span>
        <strong>
          {report.year} · {report.revision}
        </strong>
        <b className={`report-status report-status--${report.status.toLowerCase()}`}>
          {formatReportStatus(report.status)}
        </b>
      </span>
      <small className={isCurrent ? 'is-current' : undefined}>
        {isCurrent
          ? report.verified
            ? '현재 발행본'
            : '현재 작업본 · 미발행'
          : '이전 발행 snapshot'}{' '}
        · {formatReportWon(report.profitWon)}
      </small>
      <em>{report.verified ? '✓ GIWA 검증됨' : '○ 검토·발행 대기'}</em>
    </button>
  )
}

function ReportWebView({
  onClose,
  report,
}: {
  onClose: () => void
  report: ReportSnapshot
}) {
  return (
    <div className="report-overlay" role="presentation">
      <section
        aria-labelledby="report-web-view-title"
        aria-modal="true"
        className="report-web-view"
        role="dialog"
      >
        <header>
          <div>
            <p>PUBLISHED REPORT</p>
            <h2 id="report-web-view-title">
              {report.year} 세무 검토용 장부
            </h2>
            <span>
              {report.revision} · {report.issuedAt} 발행 · {report.status}
            </span>
          </div>
          <button type="button" onClick={onClose}>
            발행 내역으로
          </button>
        </header>

        <section className="report-web-summary" aria-label="보고서 요약">
          <dl>
            <div>
              <dt>예상 손익</dt>
              <dd>{formatReportWon(report.profitWon)}</dd>
            </div>
            <div>
              <dt>Coverage</dt>
              <dd>
                완전 {report.completeCount} · 예외 {report.exceptionCount}
              </dd>
            </div>
            <div>
              <dt>거래 수</dt>
              <dd>{report.transactionCount}건</dd>
            </div>
            <div>
              <dt>현재 상태</dt>
              <dd>{report.status === 'FINAL' ? '확정 발행본' : '검토 예외 포함'}</dd>
            </div>
          </dl>
          <p>
            {report.outputsConsistent
              ? 'PDF·CSV·JSON·Manifest·Evidence Pack이 같은 snapshot에서 생성되었습니다.'
              : '산출물 snapshot 일치 여부를 다시 확인해야 합니다.'}
          </p>
        </section>

        <section className="report-web-transactions">
          <header>
            <div>
              <p>TRANSACTION SUMMARY</p>
              <h3>거래 요약</h3>
            </div>
            <span>공유 화면에는 지갑 주소와 원본 거래 식별자를 표시하지 않습니다.</span>
          </header>
          <div className="report-web-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">거래</th>
                  <th scope="col">일시</th>
                  <th scope="col">소스</th>
                  <th scope="col">상태</th>
                </tr>
              </thead>
              <tbody>
                {report.transactionSummaries.map((transaction, index) => (
                  <tr key={`${transaction.occurredAt}-${transaction.title}-${index}`}>
                    <th scope="row">{transaction.title}</th>
                    <td>{transaction.occurredAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>{transaction.source}</td>
                    <td>{transaction.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {report.transactionSummaries.length < report.transactionCount && (
            <p>
              이 발행 snapshot의 대표 {report.transactionSummaries.length}건만
              웹에 표시합니다. 전체 상세는 동일 snapshot의 CSV에서 확인합니다.
            </p>
          )}
        </section>

        <section className="report-web-evidence">
          <div>
            <p>EVIDENCE &amp; INTEGRITY</p>
            <h3>재현·검증 정보</h3>
          </div>
          <dl>
            <div>
              <dt>Revision</dt>
              <dd>{report.revision}</dd>
            </div>
            <div>
              <dt>Snapshot</dt>
              <dd>{report.snapshotId}</dd>
            </div>
            <div>
              <dt>Manifest</dt>
              <dd>{report.manifestId}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{report.network}</dd>
            </div>
            <div>
              <dt>Commitment</dt>
              <dd>{report.commitment}</dd>
            </div>
            <div>
              <dt>Attestation UID</dt>
              <dd>{report.attestationUid}</dd>
            </div>
          </dl>
          <p>{reportIntegrityNotice}</p>
        </section>
      </section>
    </div>
  )
}

function ReportShareDialog({
  onClose,
  report,
}: {
  onClose: () => void
  report: ReportSnapshot
}) {
  const [recipientEmail, setRecipientEmail] = useState('')
  const [expiresInDays, setExpiresInDays] = useState(7)
  const [share, setShare] = useState<MockReportShare | null>(null)
  const [copyFeedback, setCopyFeedback] = useState('')

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setShare(
      createMockReportShare({
        expiresInDays,
        recipientEmail,
        report,
      }),
    )
  }

  async function copyShareUrl() {
    if (!share) return

    try {
      await navigator.clipboard?.writeText(share.url)
      setCopyFeedback('공유 링크를 복사했습니다.')
    } catch {
      setCopyFeedback('아래 링크를 선택해 복사해 주세요.')
    }
  }

  return (
    <div className="report-overlay" role="presentation">
      <section
        aria-labelledby="report-share-title"
        aria-modal="true"
        className="report-share"
        role="dialog"
      >
        <header>
          <div>
            <p>SHARE EVIDENCE PACK</p>
            <h2 id="report-share-title">세무사에게 보고서 공유</h2>
            <span>
              {report.year} · {report.revision} 발행본의 제한된 열람 링크를
              만듭니다.
            </span>
          </div>
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </header>

        {!share ? (
          <form onSubmit={handleSubmit}>
            <label htmlFor="report-share-email">
              받는 사람 이메일 <b aria-hidden="true">*</b>
            </label>
            <input
              id="report-share-email"
              type="email"
              autoComplete="email"
              required
              value={recipientEmail}
              onChange={(event) => setRecipientEmail(event.target.value)}
              placeholder="tax@example.com"
            />
            <small>Mock 화면에서는 이메일을 전송하지 않고 공유 상태만 생성합니다.</small>

            <label htmlFor="report-share-expiry">열람 기한</label>
            <select
              id="report-share-expiry"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              <option value={3}>3일</option>
              <option value={7}>7일</option>
              <option value={14}>14일</option>
              <option value={30}>30일</option>
            </select>

            <fieldset>
              <legend>공유 범위</legend>
              <ul>
                <li>포함 · 예상 손익, Coverage, 거래 요약, revision</li>
                <li>포함 · Manifest, Evidence Pack, GIWA 검증 메타데이터</li>
                <li>제외 · 지갑 주소, 원본 거래 식별자, 개인정보, API 비밀값</li>
              </ul>
            </fieldset>

            <div className="report-share__preview">
              <span>공유 화면 미리보기</span>
              <strong>
                {report.year} 장부 {report.revision} ·{' '}
                {formatReportWon(report.profitWon)}
              </strong>
              <p>
                {report.transactionCount}건 · 완전 {report.completeCount} · 예외{' '}
                {report.exceptionCount} · {report.network} 검증
              </p>
            </div>

            <p className="report-share__notice">{reportIntegrityNotice}</p>
            <button type="submit" className="report-share__submit">
              제한된 공유 링크 만들기
            </button>
          </form>
        ) : (
          <div className="report-share__success" role="status">
            <span aria-hidden="true">✓</span>
            <h3>공유 링크가 준비되었습니다</h3>
            <p>
              {share.recipientEmail}에게 전달할 수 있는 {expiresInDays}일
              만료 링크입니다. 실제 메일은 전송되지 않았습니다.
            </p>
            <label htmlFor="report-share-url">공유 링크</label>
            <input id="report-share-url" readOnly value={share.url} />
            <button type="button" onClick={copyShareUrl}>
              공유 링크 복사
            </button>
            {copyFeedback && <small aria-live="polite">{copyFeedback}</small>}
            <dl>
              <div>
                <dt>발행본</dt>
                <dd>{report.revision}</dd>
              </div>
              <div>
                <dt>만료 시각</dt>
                <dd>{share.expiresAt.slice(0, 16).replace('T', ' ')}</dd>
              </div>
              <div>
                <dt>공유 범위</dt>
                <dd>요약 · 거래 요약 · 증빙 메타데이터</dd>
              </div>
            </dl>
          </div>
        )}
      </section>
    </div>
  )
}

export function ReportPage() {
  const ledgerResponse = useMemo(() => readMockLedgerTransactions(), [])
  const reports = useMemo(
    () => createMockReports(ledgerResponse.data.items),
    [ledgerResponse.data.items],
  )
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')
  const visibleReports = reports.filter((report) => report.year === selectedYear)
  const requestedReportId = new URLSearchParams(window.location.search).get('report')
  const [selectedReportId, setSelectedReportId] = useState(
    reports.find((report) => report.id === requestedReportId)?.id ??
      reports[0]?.id ??
      '',
  )
  const selectedReport =
    visibleReports.find((report) => report.id === selectedReportId) ??
    visibleReports[0]
  const currentReportId = visibleReports[0]?.id
  const isSelectedCurrent = selectedReport?.id === currentReportId
  const initialSurface = new URLSearchParams(window.location.search).get('view')
  const [surface, setSurface] = useState<'share' | 'web' | null>(
    initialSurface === 'web' && selectedReport?.verified ? 'web' : null,
  )
  const [verificationFeedback, setVerificationFeedback] = useState('')

  if (!selectedReport) {
    return null
  }

  function openSurface(nextSurface: 'share' | 'web') {
    if (!selectedReport?.verified) return

    setSurface(nextSurface)
    if (nextSurface === 'web') {
      const url = new URL(window.location.href)
      url.searchParams.set('view', 'web')
      url.searchParams.set('report', selectedReport?.id ?? '')
      window.history.replaceState({}, '', url)
    }
  }

  function closeSurface() {
    setSurface(null)
    const url = new URL(window.location.href)
    url.searchParams.delete('view')
    url.searchParams.delete('report')
    window.history.replaceState({}, '', url)
  }

  function verifyAgain() {
    if (!selectedReport?.verified) return

    setVerificationFeedback('현재 장부 데이터와 GIWA commitment가 일치합니다.')
  }

  return (
    <div className="ledger-page report-page product-shell">
      <AppSidebar
        activePage="reports"
        onYearChange={(year) => {
          setSelectedYear(year)
          setSelectedReportId('')
          setSurface(null)
        }}
        year={selectedYear}
      />

      <main className="report-main">
        <PageHeader
          actions={<a href="/app/ledger">장부 작업으로</a>}
          description="발행한 장부와 Evidence Pack, GIWA 무결성 상태를 한 곳에서 확인합니다."
          eyebrow="REPORTS"
          title="보고서"
          tone="workspace"
        />

        <div className="report-layout">
          <section className="report-history" aria-labelledby="report-history-title">
            <h2 id="report-history-title">작업본 · 발행 내역</h2>
            <div>
              {visibleReports.map((report, index) => (
                <ReportHistoryItem
                  active={report.id === selectedReport.id}
                  isCurrent={index === 0}
                  key={report.id}
                  onSelect={() => {
                    setSelectedReportId(report.id)
                    setSurface(null)
                  }}
                  report={report}
                />
              ))}
            </div>
            <p>
              기존 발행본은 수정하지 않습니다. 입력이나 검토가 바뀌면 새
              revision으로 발행합니다.
            </p>
          </section>

          <div className="report-detail-column">
            <section className="report-detail" aria-labelledby="report-detail-title">
              <header>
                <div>
                  <span>
                    <h2 id="report-detail-title">
                      {selectedReport.year} 장부 · {selectedReport.revision}
                    </h2>
                    <b
                      className={`report-status report-status--${selectedReport.status.toLowerCase()}`}
                    >
                      {formatReportStatus(selectedReport.status)}
                    </b>
                  </span>
                  <p>
                    {isSelectedCurrent && !selectedReport.verified
                      ? '현재 거래와 검토 상태를 반영한 미발행 작업본'
                      : `발행 ${selectedReport.issuedAt} · 세무 검토용 장부`}
                    {selectedReport.status === 'PARTIAL' ? ' · 예외 포함' : ''}
                  </p>
                </div>
                <div className="report-detail__actions">
                  <button
                    type="button"
                    disabled={!selectedReport.verified}
                    title={
                      selectedReport.verified
                        ? undefined
                        : '장부 작업에서 검토와 발행을 완료해 주세요.'
                    }
                    onClick={() => openSurface('web')}
                  >
                    웹으로 보기
                  </button>
                  <button
                    type="button"
                    disabled={!selectedReport.verified}
                    title={
                      selectedReport.verified
                        ? undefined
                        : '발행된 보고서만 세무사에게 공유할 수 있습니다.'
                    }
                    onClick={() => openSurface('share')}
                  >
                    세무사에게 공유
                  </button>
                </div>
              </header>

              <dl className="report-stats">
                <div>
                  <dt>예상 손익 {selectedReport.status === 'PARTIAL' && '(잠정)'}</dt>
                  <dd>{formatReportWon(selectedReport.profitWon)}</dd>
                </div>
                <div>
                  <dt>Coverage</dt>
                  <dd>
                    완전 {selectedReport.completeCount} · 예외{' '}
                    {selectedReport.exceptionCount}
                  </dd>
                </div>
                <div>
                  <dt>거래 수</dt>
                  <dd>{selectedReport.transactionCount}건</dd>
                </div>
              </dl>

              <div className="report-outputs">
                <header>
                  <h3>산출물</h3>
                  <p>
                    {selectedReport.verified
                      ? 'PDF·CSV·JSON·Manifest·Evidence Pack이 같은 snapshot에서 생성되었습니다.'
                      : '검토를 완료하고 발행하면 동일 snapshot의 산출물을 다운로드할 수 있습니다.'}
                  </p>
                </header>
                <div>
                  {selectedReport.outputs.map((output) => (
                    <button
                      type="button"
                      key={output.format}
                      disabled={!selectedReport.verified}
                      onClick={() => downloadOutput(output, selectedReport)}
                    >
                      <strong>{output.label}</strong>
                      <span>
                        {selectedReport.verified
                          ? output.format === 'print'
                            ? '인쇄·PDF 저장 ↗'
                            : '다운로드 ↓'
                          : '발행 후 사용'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="report-integrity" aria-labelledby="integrity-title">
              <header>
                <h2 id="integrity-title">GIWA 무결성 검증</h2>
                <button
                  type="button"
                  disabled={!selectedReport.verified}
                  onClick={verifyAgain}
                >
                  다시 검증
                </button>
              </header>

              <div
                className={`report-integrity__banner${
                  selectedReport.verified ? '' : ' is-pending'
                }`}
              >
                <span>{selectedReport.verified ? '✓' : '○'}</span>
                <div>
                  <strong>
                    {selectedReport.verified
                      ? 'GIWA에 기록됨 · 일치'
                      : '아직 발행되지 않음 · 검증 대기'}
                  </strong>
                  <p>
                    {selectedReport.verified
                      ? '발행한 장부와 온체인 기록이 동일합니다. 파일이 바뀌면 검증에 실패합니다.'
                      : '장부 작업에서 남은 검토를 처리하고 발행 후 검증을 실행해 주세요.'}
                  </p>
                </div>
              </div>

              {verificationFeedback && (
                <p className="report-verification-feedback" role="status">
                  {verificationFeedback}
                </p>
              )}

              <dl>
                <div>
                  <dt>네트워크</dt>
                  <dd>{selectedReport.network}</dd>
                </div>
                <div>
                  <dt>기록 시각</dt>
                  <dd>{selectedReport.verified ? selectedReport.issuedAt.slice(5) : '미기록'}</dd>
                </div>
                <div>
                  <dt>Commitment</dt>
                  <dd>{selectedReport.verified ? selectedReport.commitment : '생성 전'}</dd>
                </div>
                <div>
                  <dt>Attestation UID</dt>
                  <dd>{selectedReport.verified ? selectedReport.attestationUid : '생성 전'}</dd>
                </div>
                <div>
                  <dt>Attester · 철회/만료</dt>
                  <dd className={selectedReport.verified ? 'is-positive' : undefined}>
                    {selectedReport.verified ? '허용 · 유효' : '발행 대기'}
                  </dd>
                </div>
                <div>
                  <dt>산출물 snapshot</dt>
                  <dd className={selectedReport.outputsConsistent ? 'is-positive' : undefined}>
                    {selectedReport.outputsConsistent ? '모두 일치' : '확인 필요'}
                  </dd>
                </div>
              </dl>

              <p className="report-integrity__notice">
                {reportIntegrityNotice} 온체인에는 비식별 commitment 해시만
                기록됩니다.
              </p>
            </section>
          </div>
        </div>
      </main>

      {surface === 'web' && (
        <ReportWebView onClose={closeSurface} report={selectedReport} />
      )}
      {surface === 'share' && (
        <ReportShareDialog onClose={closeSurface} report={selectedReport} />
      )}
    </div>
  )
}
