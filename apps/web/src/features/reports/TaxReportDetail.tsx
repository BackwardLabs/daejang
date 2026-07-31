import type {
  TaxAmountModel,
  TaxReportDetailModel,
} from './taxReportApi.ts'

function decimal(value: string) {
  const [integer = '', fraction] = value.split('.', 2)
  const sign = integer.startsWith('-') ? '-' : ''
  const digits = sign ? integer.slice(1) : integer
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
}

function amountLabel(amount: TaxAmountModel, denomination: string) {
  if (
    !amount.hasAmount ||
    amount.amount === null ||
    amount.amount === undefined
  ) {
    return '미확정'
  }
  return `${decimal(amount.amount)} ${denomination}`
}

function AmountValue({
  amount,
  denomination,
}: {
  amount: TaxAmountModel
  denomination: string
}) {
  const unknown =
    !amount.hasAmount ||
    amount.amount === null ||
    amount.amount === undefined

  return (
    <span className="tax-report-detail__amount" data-certainty={unknown ? 'UNKNOWN' : 'KNOWN'}>
      {amountLabel(amount, denomination)}
    </span>
  )
}

function EmptyRows({ children }: { children: string }) {
  return <p className="tax-report-detail__empty">{children}</p>
}

export function TaxReportDetail({
  report,
}: {
  report: TaxReportDetailModel
}) {
  const pdfHref =
    `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`
  const constrained =
    report.status === 'PARTIAL' ||
    report.filingStatus === 'BLOCKED' ||
    report.limitations.length > 0

  return (
    <article
      className="tax-report-detail"
      aria-labelledby="tax-report-detail-title"
    >
      <header className="tax-report-detail__header">
        <div>
          <span>EXACT IMMUTABLE REPORT</span>
          <h2 id="tax-report-detail-title">
            {report.taxYear}년 세무 장부 상세
          </h2>
          <p>
            {report.reportId} ·{' '}
            {new Date(report.issuedAt).toLocaleString('ko-KR')} 발행
          </p>
        </div>
        <div className="tax-report-detail__header-actions">
          <div className="tax-report-badges" aria-label="장부 상태">
            <b data-status={report.finality}>{report.finality}</b>
            <b data-status={report.status}>{report.status}</b>
            <b data-status={report.filingStatus}>{report.filingStatus}</b>
          </div>
          <a href={pdfHref} download>
            PDF 내려받기
          </a>
        </div>
      </header>

      {constrained ? (
        <section className="tax-report-detail__warning" role="status">
          <strong>확정되지 않은 내용이 포함된 장부입니다.</strong>
          <p>
            미확정 금액은 계산값 0으로 대체하지 않았습니다. 아래 제한사항과
            영향을 받은 처분을 함께 확인해 주세요.
          </p>
        </section>
      ) : null}

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-summary-title"
      >
        <header>
          <div>
            <span>CALCULATION SUMMARY</span>
            <h3 id="tax-report-summary-title">세금 계산 요약</h3>
          </div>
          <p>표시 통화 {report.denominationAssetId}</p>
        </header>
        <dl className="tax-report-detail__summary">
          {[
            ['양도 손익', report.summary.gainLoss],
            ['과세표준', report.summary.taxableBase],
            ['국세', report.summary.nationalTax],
            ['지방세', report.summary.localTax],
            ['예상 총 세액', report.summary.totalTax],
          ].map(([label, amount]) => (
            <div key={label as string}>
              <dt>{label as string}</dt>
              <dd>
                <AmountValue
                  amount={amount as TaxAmountModel}
                  denomination={report.denominationAssetId}
                />
              </dd>
            </div>
          ))}
        </dl>
        <dl className="tax-report-detail__counts" aria-label="장부 항목 수">
          <div><dt>처분</dt><dd>{report.counts.disposals.toLocaleString('ko-KR')}건</dd></div>
          <div><dt>이체</dt><dd>{report.counts.transfers.toLocaleString('ko-KR')}건</dd></div>
          <div><dt>제외 전환</dt><dd>{report.counts.excludedConversions.toLocaleString('ko-KR')}건</dd></div>
          <div><dt>제한사항</dt><dd>{report.counts.limitations.toLocaleString('ko-KR')}건</dd></div>
        </dl>
      </section>

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-disposals-title"
      >
        <header>
          <div>
            <span>DISPOSAL LEDGER</span>
            <h3 id="tax-report-disposals-title">처분 장부</h3>
          </div>
          <p>{report.disposals.length.toLocaleString('ko-KR')}건</p>
        </header>
        {report.disposals.length === 0 ? (
          <EmptyRows>이 장부에 포함된 처분이 없습니다.</EmptyRows>
        ) : (
          <div className="tax-report-detail__table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">처분 ID</th>
                  <th scope="col">자산</th>
                  <th scope="col">최소 단위 수량</th>
                  <th scope="col">처분가액</th>
                  <th scope="col">취득원가</th>
                  <th scope="col">필요경비</th>
                  <th scope="col">손익</th>
                  <th scope="col">계산 방식</th>
                </tr>
              </thead>
              <tbody>
                {report.disposals.map((disposal) => (
                  <tr key={disposal.movementId}>
                    <th scope="row">
                      <strong>{disposal.movementId}</strong>
                      <small>{disposal.eventId}</small>
                      <small>
                        {disposal.revisionId} · {disposal.legId}
                      </small>
                    </th>
                    <td>
                      <strong>{disposal.taxAssetId}</strong>
                      <small>{disposal.ledgerAssetId}</small>
                      <small>{disposal.taxAddressId}</small>
                    </td>
                    <td className="is-numeric">{decimal(disposal.quantity)}</td>
                    <td className="is-numeric">
                      <AmountValue amount={disposal.grossProceeds} denomination={report.denominationAssetId} />
                    </td>
                    <td className="is-numeric">
                      <AmountValue amount={disposal.basis} denomination={report.denominationAssetId} />
                    </td>
                    <td className="is-numeric">
                      <AmountValue amount={disposal.ancillaryExpense} denomination={report.denominationAssetId} />
                    </td>
                    <td className="is-numeric">
                      <AmountValue amount={disposal.gainLoss} denomination={report.denominationAssetId} />
                    </td>
                    <td>{disposal.costMethod}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-transfers-title"
      >
        <header>
          <div>
            <span>NON-TAXABLE MOVEMENTS</span>
            <h3 id="tax-report-transfers-title">이체</h3>
          </div>
          <p>{report.transfers.length.toLocaleString('ko-KR')}건</p>
        </header>
        {report.transfers.length === 0 ? (
          <EmptyRows>이 장부에 포함된 이체가 없습니다.</EmptyRows>
        ) : (
          <div className="tax-report-detail__table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">이체 ID</th>
                  <th scope="col">자산</th>
                  <th scope="col">최소 단위 수량</th>
                  <th scope="col">이동 경로</th>
                  <th scope="col">승계 취득원가</th>
                  <th scope="col">계산 방식</th>
                </tr>
              </thead>
              <tbody>
                {report.transfers.map((transfer) => (
                  <tr key={transfer.movementId}>
                    <th scope="row">
                      <strong>{transfer.movementId}</strong>
                      <small>{transfer.eventId}</small>
                      <small>{transfer.revisionId}</small>
                    </th>
                    <td>{transfer.taxAssetId}</td>
                    <td className="is-numeric">{decimal(transfer.quantity)}</td>
                    <td>
                      <strong>{transfer.fromAddressId}</strong>
                      <small>→ {transfer.toAddressId}</small>
                      <small>
                        {transfer.fromLegId} → {transfer.toLegId}
                      </small>
                    </td>
                    <td className="is-numeric">
                      <AmountValue amount={transfer.basis} denomination={report.denominationAssetId} />
                    </td>
                    <td>
                      {transfer.fromCostMethod} → {transfer.toCostMethod}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-excluded-title"
      >
        <header>
          <div>
            <span>EXCLUDED CONVERSIONS</span>
            <h3 id="tax-report-excluded-title">과세 제외 전환</h3>
          </div>
          <p>{report.excludedConversions.length.toLocaleString('ko-KR')}건</p>
        </header>
        {report.excludedConversions.length === 0 ? (
          <EmptyRows>과세 대상에서 제외된 동일 자산 전환이 없습니다.</EmptyRows>
        ) : (
          <div className="tax-report-detail__table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">관계 ID</th>
                  <th scope="col">자산</th>
                  <th scope="col">전환 전 최소 단위</th>
                  <th scope="col">전환 후 최소 단위</th>
                  <th scope="col">세무 주소</th>
                </tr>
              </thead>
              <tbody>
                {report.excludedConversions.map((conversion) => (
                  <tr key={`${conversion.eventId}:${conversion.revisionId}:${conversion.relationId}`}>
                    <th scope="row">
                      <strong>{conversion.relationId}</strong>
                      <small>{conversion.eventId}</small>
                      <small>{conversion.revisionId}</small>
                    </th>
                    <td>{conversion.taxAssetId}</td>
                    <td className="is-numeric">{decimal(conversion.fromQuantity)}</td>
                    <td className="is-numeric">{decimal(conversion.toQuantity)}</td>
                    <td>
                      <strong>{conversion.taxAddressId}</strong>
                      <small>
                        {conversion.fromLegId} → {conversion.toLegId}
                      </small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-limitations-title"
      >
        <header>
          <div>
            <span>LIMITATIONS</span>
            <h3 id="tax-report-limitations-title">제한사항</h3>
          </div>
          <p>{report.limitations.length.toLocaleString('ko-KR')}건</p>
        </header>
        {report.limitations.length === 0 ? (
          <EmptyRows>현재 장부 결과를 제한하는 항목이 없습니다.</EmptyRows>
        ) : (
          <ul className="tax-report-detail__limitations">
            {report.limitations.map((limitation, index) => (
              <li key={`${limitation.code}:${limitation.movementId ?? index}`}>
                <span>{limitation.code}</span>
                <div>
                  <strong>{limitation.reason}</strong>
                  <p>
                    {[
                      limitation.taxAssetId && `자산 ${limitation.taxAssetId}`,
                      limitation.taxAddressId && `주소 ${limitation.taxAddressId}`,
                      limitation.movementId && `처분 ${limitation.movementId}`,
                      limitation.reviewId && `리뷰 ${limitation.reviewId}`,
                      limitation.reviewRevisionId &&
                        `리뷰 revision ${limitation.reviewRevisionId}`,
                    ].filter(Boolean).join(' · ') || '장부 전체에 적용'}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="tax-report-detail__section"
        aria-labelledby="tax-report-methodology-title"
      >
        <header>
          <div>
            <span>METHODOLOGY &amp; TRACE</span>
            <h3 id="tax-report-methodology-title">계산 기준과 추적 정보</h3>
          </div>
          <p>이 장부를 만든 정확한 입력과 실행 기준입니다.</p>
        </header>
        <dl className="tax-report-detail__methodology">
          <div><dt>정책</dt><dd>{report.methodology.policy.name} {report.methodology.policy.version}</dd></div>
          <div><dt>엔진</dt><dd>{report.methodology.engine.name} {report.methodology.engine.version}</dd></div>
          <div><dt>Generation ID</dt><dd>{report.methodology.generationId}</dd></div>
          <div><dt>Tax inventory run</dt><dd>{report.methodology.taxInventoryRunId}</dd></div>
          <div><dt>Tax estimate</dt><dd>{report.methodology.taxEstimateId}</dd></div>
          <div><dt>Lot run</dt><dd>{report.methodology.lotRunId}</dd></div>
          <div><dt>Schema digest</dt><dd>{report.methodology.schemaDigest}</dd></div>
          <div><dt>Policy artifact</dt><dd>{report.methodology.policy.artifactDigest}</dd></div>
          <div><dt>Engine artifact</dt><dd>{report.methodology.engine.artifactDigest}</dd></div>
          <div><dt>Report model digest</dt><dd>{report.reportModelDigest}</dd></div>
          <div><dt>Input digest</dt><dd>{report.inputDigest}</dd></div>
          <div><dt>Evidence pack digest</dt><dd>{report.evidencePackDigest}</dd></div>
        </dl>
      </section>
    </article>
  )
}
