import { useEffect, useState } from 'react'
import type {
  TaxAmountModel,
  TaxReportDetailModel,
  TaxReportModel,
} from './taxReportApi.ts'
import { formatLedgerQuantity } from '../ledger/ledgerPresentation.ts'

type ReportTab =
  | 'summary'
  | 'disposals'
  | 'movements'
  | 'limitations'
  | 'trace'

const tabs: Array<{ id: ReportTab; label: string }> = [
  { id: 'summary', label: '요약' },
  { id: 'disposals', label: '처분 장부' },
  { id: 'movements', label: '이체·전환' },
  { id: 'limitations', label: '검토 필요' },
  { id: 'trace', label: '계산 근거' },
]

const reportDenominations: Record<
  string,
  { symbol: string; decimals: number }
> = {
  'asset-krw-upbit': { symbol: 'KRW', decimals: 8 },
}

const finalityLabel = (value: TaxReportModel['finality']) =>
  value === 'FINAL' ? '입력 확정' : '잠정 입력'

const calculationStatusLabel = (value: TaxReportModel['status']) =>
  value === 'FINAL' ? '계산 완료' : '부분 계산'

const filingStatusLabel = (
  value: TaxReportModel['filingStatus'],
  taxYear: number,
) => taxYear < 2027
  ? '신고용 아님'
  : value === 'READY' ? '신고 준비' : '신고 준비 불가'

const costMethodLabel = (value: string) => {
  const labels: Record<string, string> = {
    FIFO: '선입선출법',
    LIFO: '후입선출법',
    MOVING_AVERAGE: '이동평균법',
    SPECIFIC_IDENTIFICATION: '개별법',
    WEIGHTED_AVERAGE: '총평균법',
  }
  return labels[value] ?? value
}

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
  const presentation = reportDenominations[denomination]
  if (presentation) {
    return `${formatLedgerQuantity(
      amount.amount,
      presentation.decimals,
    )} ${presentation.symbol}`
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
    <span
      className="tax-report-detail__amount"
      data-certainty={unknown ? 'UNKNOWN' : 'KNOWN'}
    >
      {amountLabel(amount, denomination)}
    </span>
  )
}

function EmptyRows({ children }: { children: string }) {
  return <p className="tax-report-detail__empty">{children}</p>
}

export function TaxReportDetail({
  report,
  pointerVersion,
  isCurrent = false,
}: {
  report: TaxReportDetailModel
  pointerVersion?: TaxReportModel['pointerVersion']
  isCurrent?: boolean
}) {
  const [activeTab, setActiveTab] = useState<ReportTab>('summary')
  const pdfHref =
    `/api/v1/tax-reports/${encodeURIComponent(report.reportId)}/artifacts/pdf`
  const constrained =
    report.status === 'PARTIAL' ||
    report.filingStatus === 'BLOCKED' ||
    report.limitations.length > 0
  const policySimulation = report.taxYear < 2027

  useEffect(() => {
    setActiveTab('summary')
  }, [report.reportId])

  return (
    <article
      className="tax-report-detail"
      aria-labelledby="tax-report-detail-title"
    >
      <header className="tax-report-detail__header">
        <div>
          <span>ISSUED TAX LEDGER</span>
          <h2 id="tax-report-detail-title">
            {policySimulation
              ? `${report.taxYear}년 가상자산 세무 정책 시뮬레이션 장부`
              : `${report.taxYear}년 가상자산 세무 장부`}
          </h2>
          <p>
            {pointerVersion === undefined
              ? '발행본'
              : `revision ${String(pointerVersion)}`}
            {isCurrent ? ' · 현재 장부' : ' · 이전 발행본'} ·{' '}
            {new Date(report.issuedAt).toLocaleString('ko-KR')} 발행
          </p>
        </div>
        <div className="tax-report-detail__header-actions">
          <div className="tax-report-badges" aria-label="장부 상태">
            <b data-status={report.finality}>
              {finalityLabel(report.finality)}
            </b>
            <b data-status={report.status}>
              {calculationStatusLabel(report.status)}
            </b>
            <b
              data-status={
                policySimulation
                  ? 'POLICY_SIMULATION'
                  : report.filingStatus
              }
            >
              {filingStatusLabel(report.filingStatus, report.taxYear)}
            </b>
          </div>
          <a href={pdfHref} download>
            장부 PDF 생성
          </a>
        </div>
      </header>

      {policySimulation ? (
        <section
          className="tax-report-detail__simulation"
          role="status"
        >
          <strong>POLICY_SIMULATION · 신고용 아님</strong>
          <p>
            {report.taxYear}년 거래에 소득세법 제37조·제64조의3 및 시행령
            제88조의 2027.1.1 시행 예정 기준을 가정 적용한 정책
            시뮬레이션입니다. 실제 신고 결과나 현행 세법 적용 결과로
            사용하지 마세요.
          </p>
        </section>
      ) : null}

      {constrained ? (
        <section className="tax-report-detail__warning" role="status">
          <strong>확정되지 않은 내용이 포함된 장부입니다.</strong>
          <p>
            장부와 PDF는 생성할 수 있지만 신고 준비가 끝난 것은 아닙니다.
            미확정 금액은 0원으로 대체하지 않았으며, 검토가 필요한 항목은
            별도로 표시합니다.
          </p>
        </section>
      ) : policySimulation ? null : (
        <section className="tax-report-detail__ready" role="status">
          <strong>현재 revision의 계산 항목이 모두 준비되었습니다.</strong>
          <p>선택한 장부와 PDF는 동일한 ReportModel을 기준으로 생성됩니다.</p>
        </section>
      )}

      <div className="tax-report-detail__tabs" role="tablist" aria-label="장부 내용">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            id={`tax-report-tab-${tab.id}`}
            role="tab"
            aria-controls={`tax-report-panel-${tab.id}`}
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'limitations' && report.limitations.length > 0 ? (
              <span>{report.limitations.length.toLocaleString('ko-KR')}</span>
            ) : null}
          </button>
        ))}
      </div>

      {activeTab === 'summary' ? (
        <div
          id="tax-report-panel-summary"
          role="tabpanel"
          aria-labelledby="tax-report-tab-summary"
          className="tax-report-detail__panel"
        >
          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-ledger-summary-title"
          >
            <header>
              <div>
                <span>LEDGER TOTALS</span>
                <h3 id="tax-report-ledger-summary-title">장부 계산 요약</h3>
              </div>
              <p>표시 통화 {report.denominationAssetId}</p>
            </header>
            <dl className="tax-report-detail__summary is-ledger-total">
              {[
                ['총 처분가액', report.totals.grossProceeds],
                ['총 취득원가', report.totals.acquisitionCost],
                ['총 필요경비', report.totals.ancillaryExpense],
                ['총 양도 손익', report.totals.gainLoss],
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
          </section>

          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-tax-summary-title"
          >
            <header>
              <div>
                <span>TAX ESTIMATE</span>
                <h3 id="tax-report-tax-summary-title">세금 추정 요약</h3>
              </div>
              <p>확정되지 않은 세액은 미확정으로 표시합니다.</p>
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
              <div>
                <dt>처분</dt>
                <dd>{report.counts.disposals.toLocaleString('ko-KR')}건</dd>
              </div>
              <div>
                <dt>이체</dt>
                <dd>{report.counts.transfers.toLocaleString('ko-KR')}건</dd>
              </div>
              <div>
                <dt>제외 전환</dt>
                <dd>
                  {report.counts.excludedConversions.toLocaleString('ko-KR')}건
                </dd>
              </div>
              <div>
                <dt>검토 필요</dt>
                <dd>{report.counts.limitations.toLocaleString('ko-KR')}건</dd>
              </div>
            </dl>
          </section>

          <section
            className="tax-report-detail__section"
            aria-labelledby="tax-report-assets-title"
          >
            <header>
              <div>
                <span>BY ASSET</span>
                <h3 id="tax-report-assets-title">자산별 계산 요약</h3>
              </div>
              <p>{report.assetSummaries.length.toLocaleString('ko-KR')}개 자산</p>
            </header>
            {report.assetSummaries.length === 0 ? (
              <EmptyRows>요약할 처분 자산이 없습니다.</EmptyRows>
            ) : (
              <div className="tax-report-detail__table-scroll is-asset-summary">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">자산</th>
                      <th scope="col">처분 건수</th>
                      <th scope="col">처분 수량(최소 단위)</th>
                      <th scope="col">처분가액</th>
                      <th scope="col">취득원가</th>
                      <th scope="col">필요경비</th>
                      <th scope="col">양도 손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.assetSummaries.map((asset) => (
                      <tr key={asset.taxAssetId}>
                        <th scope="row">{asset.taxAssetId}</th>
                        <td className="is-numeric">
                          {asset.disposalCount.toLocaleString('ko-KR')}건
                        </td>
                        <td className="is-numeric">{decimal(asset.quantity)}</td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={asset.grossProceeds}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={asset.acquisitionCost}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={asset.ancillaryExpense}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={asset.gainLoss}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === 'disposals' ? (
        <section
          id="tax-report-panel-disposals"
          role="tabpanel"
          aria-labelledby="tax-report-tab-disposals"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>DISPOSAL LEDGER</span>
              <h3>처분 장부</h3>
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
                    <th scope="col">수량(최소 단위)</th>
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
                      <td className="is-numeric">
                        {decimal(disposal.quantity)}
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.grossProceeds}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.basis}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.ancillaryExpense}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td className="is-numeric">
                        <AmountValue
                          amount={disposal.gainLoss}
                          denomination={report.denominationAssetId}
                        />
                      </td>
                      <td>{costMethodLabel(disposal.costMethod)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {activeTab === 'movements' ? (
        <div
          id="tax-report-panel-movements"
          role="tabpanel"
          aria-labelledby="tax-report-tab-movements"
          className="tax-report-detail__panel"
        >
          <section className="tax-report-detail__section">
            <header>
              <div>
                <span>NON-TAXABLE MOVEMENTS</span>
                <h3>이체</h3>
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
                      <th scope="col">수량(최소 단위)</th>
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
                        <td className="is-numeric">
                          {decimal(transfer.quantity)}
                        </td>
                        <td>
                          <strong>{transfer.fromAddressId}</strong>
                          <small>→ {transfer.toAddressId}</small>
                          <small>
                            {transfer.fromLegId} → {transfer.toLegId}
                          </small>
                        </td>
                        <td className="is-numeric">
                          <AmountValue
                            amount={transfer.basis}
                            denomination={report.denominationAssetId}
                          />
                        </td>
                        <td>
                          {costMethodLabel(transfer.fromCostMethod)} →{' '}
                          {costMethodLabel(transfer.toCostMethod)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="tax-report-detail__section">
            <header>
              <div>
                <span>EXCLUDED CONVERSIONS</span>
                <h3>과세 제외 전환</h3>
              </div>
              <p>
                {report.excludedConversions.length.toLocaleString('ko-KR')}건
              </p>
            </header>
            {report.excludedConversions.length === 0 ? (
              <EmptyRows>
                과세 대상에서 제외된 동일 자산 전환이 없습니다.
              </EmptyRows>
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
                      <tr
                        key={`${conversion.eventId}:${conversion.revisionId}:${conversion.relationId}`}
                      >
                        <th scope="row">
                          <strong>{conversion.relationId}</strong>
                          <small>{conversion.eventId}</small>
                          <small>{conversion.revisionId}</small>
                        </th>
                        <td>{conversion.taxAssetId}</td>
                        <td className="is-numeric">
                          {decimal(conversion.fromQuantity)}
                        </td>
                        <td className="is-numeric">
                          {decimal(conversion.toQuantity)}
                        </td>
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
        </div>
      ) : null}

      {activeTab === 'limitations' ? (
        <section
          id="tax-report-panel-limitations"
          role="tabpanel"
          aria-labelledby="tax-report-tab-limitations"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>REQUIRES ATTENTION</span>
              <h3>검토 필요 항목</h3>
            </div>
            <p>{report.limitations.length.toLocaleString('ko-KR')}건</p>
          </header>
          {report.limitations.length === 0 ? (
            <EmptyRows>현재 장부 결과를 제한하는 항목이 없습니다.</EmptyRows>
          ) : (
            <ul className="tax-report-detail__limitations">
              {report.limitations.map((limitation, index) => (
                <li
                  key={`${limitation.code}:${limitation.movementId ?? index}`}
                >
                  <span>{limitation.code}</span>
                  <div>
                    <strong>{limitation.reason}</strong>
                    <p>
                      {[
                        limitation.taxAssetId &&
                          `자산 ${limitation.taxAssetId}`,
                        limitation.taxAddressId &&
                          `주소 ${limitation.taxAddressId}`,
                        limitation.movementId &&
                          `처분 ${limitation.movementId}`,
                      ]
                        .filter(Boolean)
                        .join(' · ') || '장부 전체에 적용'}
                    </p>
                    {limitation.reviewId ||
                    limitation.reviewRevisionId ? (
                      <details>
                        <summary>검토 추적 정보</summary>
                        <p>
                          {[
                            limitation.reviewId &&
                              `Review ${limitation.reviewId}`,
                            limitation.reviewRevisionId &&
                              `revision ${limitation.reviewRevisionId}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </details>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {activeTab === 'trace' ? (
        <section
          id="tax-report-panel-trace"
          role="tabpanel"
          aria-labelledby="tax-report-tab-trace"
          className="tax-report-detail__section tax-report-detail__panel"
        >
          <header>
            <div>
              <span>METHODOLOGY &amp; TRACE</span>
              <h3>계산 기준과 추적 정보</h3>
            </div>
            <p>선택한 revision을 재현하는 데 필요한 식별 정보입니다.</p>
          </header>
          <dl className="tax-report-detail__methodology">
            <div>
              <dt>Report ID</dt>
              <dd>{report.reportId}</dd>
            </div>
            {policySimulation ? (
              <div>
                <dt>계산 성격</dt>
                <dd>
                  POLICY_SIMULATION · 소득세법 제37조·제64조의3 및 시행령
                  제88조 · 2027.1.1 시행 예정 · 신고용 아님
                </dd>
              </div>
            ) : null}
            <div>
              <dt>정책</dt>
              <dd>
                {report.methodology.policy.name}{' '}
                {report.methodology.policy.version}
              </dd>
            </div>
            <div>
              <dt>엔진</dt>
              <dd>
                {report.methodology.engine.name}{' '}
                {report.methodology.engine.version}
              </dd>
            </div>
            <div>
              <dt>Generation ID</dt>
              <dd>{report.methodology.generationId}</dd>
            </div>
            <div>
              <dt>Tax inventory run</dt>
              <dd>{report.methodology.taxInventoryRunId}</dd>
            </div>
            <div>
              <dt>Tax estimate</dt>
              <dd>{report.methodology.taxEstimateId}</dd>
            </div>
            <div>
              <dt>Lot run</dt>
              <dd>{report.methodology.lotRunId}</dd>
            </div>
            <div>
              <dt>Schema digest</dt>
              <dd>{report.methodology.schemaDigest}</dd>
            </div>
            <div>
              <dt>Policy artifact</dt>
              <dd>{report.methodology.policy.artifactDigest}</dd>
            </div>
            <div>
              <dt>Engine artifact</dt>
              <dd>{report.methodology.engine.artifactDigest}</dd>
            </div>
            <div>
              <dt>Report model digest</dt>
              <dd>{report.reportModelDigest}</dd>
            </div>
            <div>
              <dt>Input digest</dt>
              <dd>{report.inputDigest}</dd>
            </div>
            <div>
              <dt>Evidence pack digest</dt>
              <dd>{report.evidencePackDigest}</dd>
            </div>
          </dl>
        </section>
      ) : null}
    </article>
  )
}
