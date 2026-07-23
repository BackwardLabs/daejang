import { useMemo, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  deriveMockLedgerRevisionHistory,
  deriveMockLedgerResult,
  formatMockLedgerWon,
  holdMockLedgerReview,
  ledgerPipeline,
  ledgerRevisionResults,
  ledgerStateMocks,
  publishMockLedgerSnapshot,
  readMockLedgerTransactions,
  resumeMockLedgerReview,
  submitMockLedgerReview,
  type LedgerFlowState,
  type LedgerReviewResult,
  type LedgerStateMock,
  type LedgerTone,
  type LedgerTransaction,
} from '../../mocks/ledger.ts'
import './ledger.css'

const subNavigation: Array<{
  label: string
  state: LedgerFlowState
  states: LedgerFlowState[]
}> = [
  { label: '거래 목록', state: 'A', states: ['A', 'A+', 'J', 'S0', 'S1', 'S2', 'S3', 'R'] },
  { label: '검토', state: 'B', states: ['B', 'C', 'D', 'C0'] },
  { label: '보류함', state: 'P', states: ['P'] },
  { label: '결과·근거', state: 'E', states: ['E', 'G', 'G1', 'OK'] },
  { label: 'Revision 비교', state: 'F', states: ['F'] },
]

const pipelineActiveStep: Record<LedgerFlowState, number> = {
  S0: 0,
  S1: 1,
  S2: 1,
  S3: 1,
  R: 2,
  A: 4,
  'A+': 5,
  B: 4,
  C: 4,
  C0: 5,
  D: 4,
  E: 5,
  P: 4,
  F: 5,
  G: 6,
  G1: 6,
  OK: 8,
  J: 5,
}

function ToneText({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: LedgerTone
}) {
  return <span className={`ledger-tone ledger-tone--${tone}`}>{children}</span>
}

function getFirstTransaction(transactions: LedgerTransaction[]): LedgerTransaction {
  const transaction = transactions[0]

  if (!transaction) {
    throw new Error('Mock ledger transaction response must include at least one item.')
  }

  return transaction
}

function isReviewTransaction(transaction: LedgerTransaction) {
  return (
    transaction.statusCode === 'needs_review' ||
    transaction.statusCode === 'provisional'
  )
}

function getLedgerMetrics(transactions: LedgerTransaction[]) {
  return {
    confirmedCount: transactions.filter(
      (transaction) => transaction.statusCode === 'confirmed',
    ).length,
    holdCount: transactions.filter(
      (transaction) => transaction.statusCode === 'on_hold',
    ).length,
    linkedCount: transactions.filter(
      (transaction) => transaction.journey.postingIds.length > 0,
    ).length,
    normalizedCount: transactions.filter(
      (transaction) => Boolean(transaction.journey.eventId),
    ).length,
    reviewCount: transactions.filter(isReviewTransaction).length,
    totalCount: transactions.length,
    valuedCount: transactions.filter(
      (transaction) =>
        transaction.journey.steps.find((step) => step.key === 'valuation')
          ?.status === '확정',
    ).length,
  }
}

function getRuntimeStateMock(
  state: LedgerFlowState,
  transactions: LedgerTransaction[],
): LedgerStateMock {
  const mock = ledgerStateMocks[state]
  const metrics = getLedgerMetrics(transactions)
  const ledgerResult = deriveMockLedgerResult(transactions)
  const reviewTransactions = transactions.filter(
    (transaction) => transaction.reviewTask,
  )
  const resolvedTransactions = reviewTransactions.filter(
    (transaction) => transaction.reviewTask?.status === 'RESOLVED',
  )
  const displayOnlyCount = transactions.filter(
    (transaction) => transaction.statusCode === 'display_only',
  ).length

  if (state === 'E') {
    return {
      ...mock,
      title: '모든 검토 항목이 현재 revision으로 수렴했습니다',
      description: `사용자 판단 ${resolvedTransactions.length}건과 근거 체인이 ${ledgerResult.revision}에 연결되었습니다.`,
      noticeTitle: `검토 ${resolvedTransactions.length} / ${reviewTransactions.length} · 확인 ${metrics.confirmedCount} / ${metrics.totalCount}`,
      noticeBody:
        displayOnlyCount > 0
          ? `표시 전용 ${displayOnlyCount}건은 예외로 남겨 두고 산출물에 함께 기록합니다.`
          : '이제 산출물을 생성하고 GIWA commitment를 검증할 수 있습니다.',
      rows: resolvedTransactions.map((transaction) => ({
        detail:
          transaction.reviewTask?.options.find(
            (option) => option.id === transaction.reviewTask?.selectedOptionId,
          )?.label ?? transaction.detail,
        label: transaction.title,
        status: '완료',
        tone: 'positive',
      })),
      summaryValue: `${resolvedTransactions.length} / ${reviewTransactions.length}`,
      summary: [
        {
          label: '예상 손익',
          value: formatMockLedgerWon(ledgerResult.profitWon),
          tone: 'positive',
        },
        {
          label: '확인 거래',
          value: `${metrics.confirmedCount} / ${metrics.totalCount}`,
        },
        { label: '현재 revision', value: ledgerResult.revision },
      ],
    }
  }

  if (state === 'F') {
    const revisionHistory = deriveMockLedgerRevisionHistory(transactions)
    const profitDelta =
      ledgerResult.profitWon - ledgerRevisionResults['rev.4'].profitWon

    return {
      ...mock,
      description: `검토 확정마다 생성된 ${ledgerResult.resolvedReviewCount}개의 계산 revision을 순서대로 보존합니다.`,
      noticeTitle: `rev.4 → ${ledgerResult.revision}`,
      noticeBody:
        '보고서 생성은 현재 revision을 별도 발행 snapshot으로 고정하며 revision 번호를 추가로 올리지 않습니다.',
      rows: [...revisionHistory].reverse().map((revision) => ({
        label: revision.revision,
        detail:
          revision.source === 'BASELINE'
            ? '기준 계산 · 이전 발행 snapshot과 연결'
            : `${revision.transactionTitle} · ${revision.fact} · ${
                revision.profitDeltaWon === 0
                  ? '변경 없음'
                  : formatMockLedgerWon(revision.profitDeltaWon)
              }`,
        status: formatMockLedgerWon(revision.profitWon),
        tone:
          revision.profitDeltaWon > 0
            ? 'positive'
            : revision.profitDeltaWon < 0
              ? 'negative'
              : 'neutral',
      })),
      summaryValue: formatMockLedgerWon(profitDelta),
      summary: [
        {
          label: '보존 revision',
          value: `${revisionHistory.length}개`,
        },
        { label: '발행 snapshot', value: '별도' },
        { label: '현재 revision', value: ledgerResult.revision },
      ],
    }
  }

  if (state === 'G') {
    return {
      ...mock,
      description: `PDF·CSV·JSON·Manifest·Evidence Pack의 ${metrics.totalCount}개 거래와 합계를 대조합니다.`,
      noticeTitle: `발행 snapshot · ${ledgerResult.revision}`,
      noticeBody: '원본 범위, 정책 버전, 사용자 판단, 예외 목록을 하나의 Manifest로 고정합니다.',
      rows: [
        {
          label: 'PDF 요약',
          detail: `${metrics.totalCount}개 거래 · 손익 ${formatMockLedgerWon(ledgerResult.profitWon)}`,
          status: '준비',
          tone: 'accent',
        },
        {
          label: 'CSV · JSON',
          detail: `${metrics.totalCount}행 · 합계 일치`,
          status: '준비',
          tone: 'accent',
        },
        {
          label: 'Evidence Pack',
          detail: `원본·${ledgerResult.revision}·checksum`,
          status: '준비',
          tone: 'accent',
        },
      ],
      summary: [
        { label: '거래', value: `${metrics.totalCount}건` },
        { label: 'GIWA', value: '미기록' },
        { label: 'revision', value: ledgerResult.revision },
      ],
    }
  }

  if (state === 'G1') {
    const mismatchWon = 32_000

    return {
      ...mock,
      description:
        '검증에 실패한 산출물은 발행하지 않고 현재 revision과 원본을 그대로 보존합니다.',
      noticeTitle: `CSV 합계 · ${mismatchWon.toLocaleString('ko-KR')}원 차이`,
      noticeBody: `${ledgerResult.revision} 검증 예시는 배포하지 않고 정상 발행 준비 상태로 돌아갑니다.`,
      rows: [
        {
          label: 'Manifest',
          detail: `${ledgerResult.revision} · policy v1.3`,
          status: '일치',
          tone: 'positive',
        },
        {
          label: 'CSV 합계',
          detail: formatMockLedgerWon(ledgerResult.profitWon - mismatchWon),
          status: '불일치',
          tone: 'negative',
        },
        {
          label: '기대 합계',
          detail: formatMockLedgerWon(ledgerResult.profitWon),
          status: '기준',
        },
      ],
      summary: [
        { label: '검증 대상', value: ledgerResult.revision },
        {
          label: '차이',
          value: formatMockLedgerWon(-mismatchWon),
          tone: 'negative',
        },
        { label: '배포 상태', value: '차단', tone: 'negative' },
      ],
    }
  }

  if (state === 'OK') {
    return {
      ...mock,
      description: `${metrics.totalCount}개 거래의 모든 산출물이 같은 ${ledgerResult.revision} snapshot을 가리킵니다.`,
      noticeTitle: `GIWA Sepolia · ${ledgerResult.revision} · 검증 완료`,
      noticeBody: `Manifest와 Evidence Pack의 거래 ${metrics.totalCount}건 및 손익 ${formatMockLedgerWon(ledgerResult.profitWon)}이 일치합니다.`,
      rows: [
        {
          label: 'Manifest',
          detail: `manifest.2027.${ledgerResult.revision}`,
          status: '일치',
          tone: 'positive',
        },
        {
          label: '거래 범위',
          detail: `${metrics.totalCount}건 · 손익 ${formatMockLedgerWon(ledgerResult.profitWon)}`,
          status: '일치',
          tone: 'positive',
        },
        {
          label: 'Evidence Pack',
          detail: '원본·revision·정책 digest',
          status: '일치',
          tone: 'positive',
        },
      ],
      summary: [
        { label: '거래', value: `${metrics.totalCount}건` },
        { label: 'revision', value: ledgerResult.revision },
        { label: '무결성', value: '일치', tone: 'positive' },
      ],
    }
  }

  return mock
}

function LedgerSidebar({
  currentState,
  holdCount,
  onStateChange,
  onYearChange,
  resolvedReviewCount,
  reviewCount,
  year,
}: {
  currentState: LedgerFlowState
  holdCount: number
  onStateChange: (state: LedgerFlowState) => void
  onYearChange: (year: AppYear) => void
  resolvedReviewCount: number
  reviewCount: number
  year: AppYear
}) {
  const activeItem = subNavigation.find((item) => item.states.includes(currentState))
  const hasUnresolvedReview = reviewCount > 0 || holdCount > 0

  return (
    <AppSidebar
      activePage="ledger"
      activeSecondaryItem={activeItem?.state}
      onSecondarySelect={(id) => {
        const item = subNavigation.find((candidate) => candidate.state === id)
        if (item) onStateChange(item.state)
      }}
      onYearChange={onYearChange}
      secondaryItems={subNavigation.map((item) => ({
        badge:
          item.state === 'B'
            ? reviewCount > 0
              ? String(reviewCount)
              : undefined
            : item.state === 'P'
              ? holdCount > 0
                ? String(holdCount)
                : undefined
              : undefined,
        disabled:
          item.state === 'E'
            ? hasUnresolvedReview
            : item.state === 'F'
              ? resolvedReviewCount === 0
              : false,
        disabledReason:
          item.state === 'E' && hasUnresolvedReview
            ? `검토 ${reviewCount}건과 보류 ${holdCount}건을 먼저 처리해 주세요.`
            : item.state === 'F' && resolvedReviewCount === 0
              ? '검토 결과가 생기면 revision을 비교할 수 있습니다.'
              : undefined,
        id: item.state,
        label: item.label,
      }))}
      year={year}
    />
  )
}

function LedgerPipeline({
  holdCount,
  reviewCount,
  state,
  transactions,
}: {
  holdCount: number
  reviewCount: number
  state: LedgerFlowState
  transactions: LedgerTransaction[]
}) {
  const activeStep = pipelineActiveStep[state]
  const metrics = getLedgerMetrics(transactions)
  const isReviewComplete = reviewCount === 0 && holdCount === 0
  const effectiveActiveStep =
    !isReviewComplete && activeStep > 4 ? 4 : activeStep
  const details: Record<(typeof ledgerPipeline)[number]['key'], string> = {
    source: `원본 ${metrics.totalCount}건`,
    normalization: `Event ${metrics.normalizedCount}`,
    linking: `연결 ${metrics.linkedCount}`,
    valuation: `평가 ${metrics.valuedCount}/${metrics.totalCount}`,
    review:
      reviewCount > 0
        ? `지금 할 일 · ${reviewCount}`
        : holdCount > 0
          ? `보류 · ${holdCount}`
          : '검토 완료',
    result: '검토 후 확정',
    publication: 'PDF·Pack',
    verification: '무결성',
  }

  return (
    <section className="ledger-pipeline" aria-label="장부 생성 진행 단계">
      <div className="ledger-pipeline__heading">
        <span>END-TO-END</span>
        <strong>원천 데이터부터 GIWA 검증까지 · 하나의 흐름</strong>
        <p>동일 입력이면 동일 결과 재현 · 모든 줄이 원본까지 연결</p>
      </div>
      <ol>
        {ledgerPipeline.map((step, index) => {
          const isComplete =
            effectiveActiveStep === 8 ||
            index < effectiveActiveStep ||
            (step.key === 'review' && isReviewComplete)
          const isActive =
            effectiveActiveStep !== 8 &&
            index === effectiveActiveStep &&
            !isComplete
          const status = isComplete ? 'complete' : isActive ? 'active' : 'pending'

          return (
            <li
              key={step.label}
              aria-current={isActive ? 'step' : undefined}
              className={isComplete ? 'is-complete' : isActive ? 'is-active' : undefined}
              data-status={status}
            >
              <i>{isComplete ? '✓' : index + 1}</i>
              <strong>{step.label}</strong>
              <span>{details[step.key]}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function ResultSummary({
  holdCount,
  reviewCount,
  reviewResult,
  selectedTransaction,
  state,
  transactions,
}: {
  holdCount: number
  reviewCount: number
  reviewResult: LedgerReviewResult | null
  selectedTransaction: LedgerTransaction
  state: LedgerFlowState
  transactions: LedgerTransaction[]
}) {
  const mock = getRuntimeStateMock(state, transactions)
  const metrics = getLedgerMetrics(transactions)
  const ledgerResult = deriveMockLedgerResult(transactions)
  const selectedRevision =
    reviewResult?.revision ??
    selectedTransaction.journey.currentRevisionId.match(/rev\.\d+$/)?.[0] ??
    '—'
  const specialized =
    state === 'A' || state === 'B' || state === 'C'
      ? [
          {
            label: '확인된 거래',
            value: `${metrics.confirmedCount} / ${metrics.totalCount}`,
            tone: 'positive' as const,
          },
          {
            label: '검토 필요',
            value: `${reviewCount}건`,
            tone: reviewCount > 0 ? ('negative' as const) : ('positive' as const),
          },
          {
            label: '보류',
            value: `${holdCount}건`,
            tone: holdCount > 0 ? ('warning' as const) : ('positive' as const),
          },
          {
            label: '현재 revision',
            value: ledgerResult.revision,
          },
        ]
      : state === 'P'
        ? [
            {
              label: '검토 필요',
              value: `${reviewCount}건`,
              tone:
                reviewCount > 0 ? ('negative' as const) : ('positive' as const),
            },
            {
              label: '보류',
              value: `${holdCount}건`,
              tone: holdCount > 0 ? ('warning' as const) : ('positive' as const),
            },
            {
              label: '확인됨',
              value: `${metrics.confirmedCount}건`,
              tone: 'positive' as const,
            },
            { label: '전체 거래', value: `${metrics.totalCount}건` },
          ]
        : state === 'A+' || state === 'J'
          ? [
              {
                label: '거래 일시',
                value: selectedTransaction.occurredAt.slice(0, 16).replace('T', ' '),
              },
              {
                label: '근거 노드',
                value: String(selectedTransaction.journey.steps.length),
              },
              {
                label: '현재 revision',
                value: selectedRevision,
              },
            ]
          : mock.summary
  const summaryValue =
    state === 'P'
      ? `${holdCount}건`
      : state === 'A+' || state === 'J'
        ? selectedTransaction.impact.match(/[+-]?[\d,]+/)
          ? `${selectedTransaction.impact}원`
          : selectedTransaction.impact
        : state === 'A' || state === 'B' || state === 'C'
          ? formatMockLedgerWon(ledgerResult.profitWon)
          : mock.summaryValue

  return (
    <aside className="ledger-summary-card">
      <h2>{state === 'A' || state === 'B' || state === 'C' ? '현재 결과 요약' : '현재 상태'}</h2>
      <strong>{summaryValue}</strong>
      <dl>
        {specialized.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>
              <ToneText tone={item.tone}>{item.value}</ToneText>
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}

function NextActionCard({
  holdCount,
  state,
  onMove,
  reviewCount,
}: {
  holdCount: number
  state: LedgerFlowState
  onMove: (state: LedgerFlowState) => void
  reviewCount: number
}) {
  const mock = ledgerStateMocks[state]
  const hasNoOutstandingReview = reviewCount === 0 && holdCount === 0
  const isReviewComplete =
    hasNoOutstandingReview && (state === 'A' || state === 'C')
  const shouldOpenHold =
    reviewCount === 0 &&
    holdCount > 0 &&
    (state === 'A' || state === 'C')
  const description =
    state === 'P'
      ? holdCount > 0
        ? `보류한 ${holdCount}건 중 하나를 선택하면 같은 질문에서 검토를 재개합니다.`
        : '보류된 거래가 없습니다. 거래 목록으로 돌아갈 수 있습니다.'
      : state === 'F'
        ? hasNoOutstandingReview
          ? '모든 revision을 확인했습니다. 현재 결과·근거 단계로 이동할 수 있습니다.'
          : `revision 이력은 보존되었습니다. 남은 검토 ${reviewCount}건과 보류 ${holdCount}건을 이어서 처리해 주세요.`
      : (state === 'A' || state === 'C') && reviewCount > 0
      ? `남은 검토 ${reviewCount}건을 이어서 사실만 확인해 주세요.`
      : shouldOpenHold
        ? `검토 대기 항목은 없지만 보류 ${holdCount}건이 남아 있습니다.`
      : isReviewComplete
        ? '모든 검토가 완료되었습니다. 결과·근거 단계로 이동할 수 있습니다.'
        : mock.nextDescription
  const actionLabel =
    state === 'P' && holdCount === 0
      ? '거래 목록으로 →'
      : state === 'F'
        ? hasNoOutstandingReview
          ? '결과·근거 보기 →'
          : '검토 계속 →'
      : shouldOpenHold
        ? '보류함 보기 →'
        : isReviewComplete
          ? '결과·근거 보기 →'
          : mock.actionLabel
  const nextState =
    state === 'P' && holdCount === 0
      ? 'A'
      : state === 'F'
        ? hasNoOutstandingReview
          ? 'E'
          : 'A'
      : shouldOpenHold
        ? 'P'
        : isReviewComplete
          ? 'E'
          : mock.nextState

  return (
    <aside className="ledger-next-card">
      <span>다음 할 일</span>
      <h2>{description}</h2>
      <button type="button" onClick={() => onMove(nextState)}>
        {actionLabel}
      </button>
      {state === 'G' && (
        <button type="button" className="is-secondary" onClick={() => onMove('G1')}>
          불일치 예시 보기
        </button>
      )}
    </aside>
  )
}

function TransactionsWorkspace({
  onTransactionSelect,
  transactions,
}: {
  onTransactionSelect: (transaction: LedgerTransaction) => void
  transactions: LedgerTransaction[]
}) {
  const [filter, setFilter] = useState<'all' | 'confirmed' | 'review'>('review')
  const [page, setPage] = useState(1)
  const pageSize = 10
  const filteredTransactions = useMemo(() => {
    if (filter === 'confirmed') return transactions.filter((item) => item.confirmed)
    if (filter === 'review') {
      return transactions.filter(
        (item) =>
          item.statusCode === 'needs_review' || item.statusCode === 'provisional',
      )
    }
    return transactions
  }, [filter, transactions])
  const metrics = getLedgerMetrics(transactions)
  const pageCount = Math.max(
    1,
    Math.ceil(filteredTransactions.length / pageSize),
  )
  const currentPage = Math.min(page, pageCount)
  const visibleTransactions = filteredTransactions.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  )
  const pageStart =
    filteredTransactions.length === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const pageEnd = Math.min(currentPage * pageSize, filteredTransactions.length)

  function selectFilter(nextFilter: typeof filter) {
    setFilter(nextFilter)
    setPage(1)
  }

  return (
    <section className="ledger-workspace">
      <div className="ledger-workspace__heading">
        <div>
          <h2>거래 목록</h2>
          <p>행을 누르면 근거 체인이 펼쳐지고 확인 거래는 전체 여정을 보여줍니다.</p>
        </div>
      </div>

      <div className="ledger-filters" role="group" aria-label="거래 상태 필터">
        <button
          type="button"
          className={filter === 'review' ? 'is-active' : undefined}
          onClick={() => selectFilter('review')}
        >
          검토 필요 {metrics.reviewCount}
        </button>
        <button
          type="button"
          className={filter === 'all' ? 'is-active' : undefined}
          onClick={() => selectFilter('all')}
        >
          전체 {metrics.totalCount}
        </button>
        <button
          type="button"
          className={filter === 'confirmed' ? 'is-active' : undefined}
          onClick={() => selectFilter('confirmed')}
        >
          확인 {metrics.confirmedCount}
        </button>
      </div>

      <div className="ledger-transaction-header">
        <span>거래</span>
        <span>예상 손익 · 영향</span>
        <span>상태</span>
      </div>

      <div className="ledger-transaction-list">
        {visibleTransactions.map((transaction) => (
          <button
            type="button"
            key={transaction.id}
            className={transaction.confirmed ? 'is-confirmed' : undefined}
            onClick={() => onTransactionSelect(transaction)}
          >
            <span className="ledger-transaction-name">
              <strong>{transaction.title}</strong>
              <small>
                · {transaction.date} · {transaction.detail} · {transaction.source.name}
              </small>
            </span>
            <ToneText tone={transaction.impactTone}>{transaction.impact}</ToneText>
            <ToneText tone={transaction.statusTone}>{transaction.status}</ToneText>
            <b aria-hidden="true">›</b>
          </button>
        ))}
        {visibleTransactions.length === 0 && (
          <div className="ledger-empty-state" role="status">
            이 조건에 해당하는 거래가 없습니다.
          </div>
        )}
      </div>

      <div className="ledger-pagination">
        <span>
          {pageStart}–{pageEnd} / {filteredTransactions.length}
        </span>
        <div>
          <button
            type="button"
            disabled={currentPage === 1}
            onClick={() => setPage((value) => Math.max(1, value - 1))}
            aria-label="이전 페이지"
          >
            ‹
          </button>
          {Array.from({ length: pageCount }, (_, index) => index + 1).map(
            (pageNumber) => (
              <button
                type="button"
                key={pageNumber}
                className={currentPage === pageNumber ? 'is-active' : undefined}
                onClick={() => setPage(pageNumber)}
              >
                {pageNumber}
              </button>
            ),
          )}
          <button
            type="button"
            disabled={currentPage === pageCount}
            onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
            aria-label="다음 페이지"
          >
            ›
          </button>
        </div>
      </div>
    </section>
  )
}

function ReviewWorkspace({
  onHold,
  onMove,
  onSubmit,
  reviewCount,
  transaction,
}: {
  onHold: () => void
  onMove: (state: LedgerFlowState) => void
  onSubmit: (optionId: string) => void
  reviewCount: number
  transaction: LedgerTransaction
}) {
  const reviewTask = transaction.reviewTask
  const [optionId, setOptionId] = useState(reviewTask?.options[0]?.id ?? '')

  if (!reviewTask) {
    return (
      <section className="ledger-workspace">
        <div className="ledger-empty-state" role="status">
          이 거래에는 열려 있는 검토 작업이 없습니다.
        </div>
      </section>
    )
  }

  const impactLabel = /^[+−-]?\d/.test(transaction.impact)
    ? `${transaction.impact}원`
    : transaction.impact
  const evidenceSteps = transaction.journey.steps.filter(
    (step) => step.key !== 'publication',
  )

  return (
    <section className="ledger-workspace ledger-review-workspace">
      <div className="ledger-workspace__heading">
        <div>
          <h2>거래 목록 · 근거 체인</h2>
          <p>
            {transaction.title} 행 아래에서 결과 → 원본을 확인하고 필요한 사실만
            선택합니다.
          </p>
        </div>
        <span className="ledger-count-badge">남은 검토 {reviewCount}건</span>
      </div>

      <article className="ledger-evidence-card">
        <header className="ledger-review-summary">
          <div className="ledger-review-summary__identity">
            <span>REVIEW REQUIRED</span>
            <h3>{transaction.title}</h3>
            <p>
              2027-{transaction.date} · {transaction.title} ·{' '}
              {transaction.source.name}
            </p>
          </div>
          <div className="ledger-review-summary__impact">
            <span>예상 손익 · 영향</span>
            <strong>{impactLabel}</strong>
            <small>현재 잠정 결과</small>
          </div>
        </header>

        <div className="ledger-review-layout">
          <section
            className="ledger-evidence-chain"
            aria-labelledby="ledger-evidence-chain-title"
          >
            <header>
              <div>
                <span>EVIDENCE CHAIN</span>
                <h3 id="ledger-evidence-chain-title">결과에서 원본까지</h3>
              </div>
              <b>{evidenceSteps.length}단계</b>
            </header>
            <p>
              현재 결과에 사용된 정규화·해석·Posting·평가 근거입니다.
            </p>
            <ol>
              {evidenceSteps.map((step, index) => (
                <li key={step.evidenceId}>
                  <i>{index + 1}</i>
                  <span>
                    <strong>{step.label}</strong>
                    <small>{step.detail}</small>
                  </span>
                  <ToneText tone={step.tone}>{step.status}</ToneText>
                </li>
              ))}
            </ol>
          </section>

          <section
            className="ledger-review-question"
            role="group"
            aria-labelledby="ledger-review-question-title"
          >
            <header className="ledger-review-question__header">
              <small>확인할 사실</small>
              <h3 id="ledger-review-question-title">{reviewTask.prompt}</h3>
            </header>
            <div className="ledger-review-question__meta">
              <p>사유 코드 · {reviewTask.reasonCode}</p>
              <button
                type="button"
                className="ledger-text-action"
                aria-label="원본 보기"
                onClick={() => onMove('D')}
              >
                연결된 원본 보기 →
              </button>
            </div>
            <div className="ledger-review-options">
              {reviewTask.options.map((option) => (
                <label key={option.id}>
                  <input
                    type="radio"
                    name="ledger-fact"
                    value={option.id}
                    checked={optionId === option.id}
                    onChange={() => setOptionId(option.id)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>
                      {option.outcome === 'confirmed'
                        ? '선택하면 새 revision 계산에 반영합니다.'
                        : '근거가 준비될 때까지 보류함에 유지합니다.'}
                    </small>
                  </span>
                  <i aria-hidden="true">✓</i>
                </label>
              ))}
            </div>
            <p className="ledger-review-question__help">
              아는 사실만 선택해 주세요. 모르는 경우에는 보류해도 기존
              revision과 원본이 유지됩니다.
            </p>
            <div className="ledger-review-actions">
              <button
                type="button"
                className="ledger-secondary-action"
                onClick={onHold}
              >
                나중에
              </button>
              <button
                type="button"
                className="ledger-primary-action"
                disabled={!optionId}
                onClick={() => onSubmit(optionId)}
              >
                제출 →
              </button>
            </div>
          </section>
        </div>
      </article>
    </section>
  )
}

function RevisionWorkspace({
  onMove,
  onTransactionSelect,
  reviewResult,
  transactions,
}: {
  onMove: (state: LedgerFlowState) => void
  onTransactionSelect: (transaction: LedgerTransaction) => void
  reviewResult: LedgerReviewResult | null
  transactions: LedgerTransaction[]
}) {
  const reviewedTransaction =
    reviewResult?.transaction ?? getFirstTransaction(transactions)
  const reviewTransactions = transactions.filter(isReviewTransaction)
  const heldTransactions = transactions.filter(
    (transaction) => transaction.statusCode === 'on_hold',
  )
  const unresolvedCount = reviewTransactions.length + heldTransactions.length
  const revisionChain = [
    { label: '사용자 사실', value: reviewResult?.fact ?? reviewedTransaction.detail },
    { label: '정책', value: reviewedTransaction.journey.policyVersion },
    {
      label: '원본',
      value:
        reviewedTransaction.journey.steps.find((step) => step.key === 'source')
          ?.detail ?? reviewedTransaction.journey.sourceRecordId,
    },
    {
      label: '결과',
      value: `${reviewResult?.revision ?? 'rev.5'} · ${reviewResult?.impact ?? '변경 없음'}`,
    },
  ]

  return (
    <section className="ledger-workspace ledger-revision-workspace">
      <div className="ledger-workspace__heading">
        <div>
          <h2>거래 목록 · 1건 반영 완료</h2>
          <p>선택한 사실이 새 계산과 revision에 반영되었습니다.</p>
        </div>
        <span className="ledger-success-badge">
          {reviewResult?.revision ?? 'rev.5'} 생성 · {reviewResult?.impact ?? '+180,000원'}
        </span>
      </div>

      <article className="ledger-completed-row">
        <span className="ledger-completed-row__icon" aria-hidden="true">✓</span>
        <div className="ledger-completed-row__copy">
          <small>사실 반영 완료</small>
          <strong>{reviewedTransaction.title}</strong>
          <p>
            {reviewResult?.fact ?? 'Upbit 매수분입니다'} 반영 · 사용자 사실 확정 ·{' '}
            {reviewResult?.revision ?? 'rev.5'}
          </p>
        </div>
        <div className="ledger-completed-row__metric">
          <small>예상 영향</small>
          <strong>
            {reviewedTransaction.impact.match(/[+-]?[\d,]+/)
              ? `${reviewedTransaction.impact}원`
              : reviewedTransaction.impact}
          </strong>
        </div>
      </article>

      <article className="ledger-revision-chain" aria-labelledby="revision-chain-title">
        <header>
          <div>
            <small>REVISION TRACE</small>
            <h3 id="revision-chain-title">반영된 근거 체인</h3>
          </div>
          <span>{revisionChain.length}단계</span>
        </header>
        <ol>
          {revisionChain.map((item, index) => (
            <li key={item.label}>
              <i aria-hidden="true">{index + 1}</i>
              <span>
                <small>{item.label}</small>
                <strong>{item.value}</strong>
              </span>
            </li>
          ))}
        </ol>
      </article>

      <div className="ledger-revision-actions">
        <p>원본과 이전 revision은 그대로 보존됩니다.</p>
        <div>
          <button type="button" onClick={() => onMove('F')}>revision 비교</button>
          <button
            type="button"
            className="is-primary"
            disabled={unresolvedCount > 0}
            title={
              unresolvedCount > 0
                ? `검토 또는 보류 ${unresolvedCount}건을 먼저 처리해 주세요.`
                : undefined
            }
            onClick={() => onMove('E')}
          >
            검토 모두 완료
          </button>
        </div>
      </div>

      <section className="ledger-remaining-section" aria-labelledby="remaining-review-title">
        <header>
          <div>
            <h3 id="remaining-review-title">
              남은 검토 {reviewTransactions.length}건
            </h3>
            <p>거래를 선택하면 다음 질문에서 검토를 이어갑니다.</p>
          </div>
          {heldTransactions.length > 0 && (
            <button
              type="button"
              className="ledger-open-hold"
              onClick={() => onMove('P')}
            >
              보류 {heldTransactions.length}건 확인 →
            </button>
          )}
        </header>
        <div className="ledger-remaining-list">
          {reviewTransactions.map((transaction) => (
            <button
              type="button"
              className="ledger-compact-row"
              key={transaction.id}
              onClick={() => onTransactionSelect(transaction)}
            >
              <span className="ledger-compact-row__copy">
                <strong>{transaction.title}</strong>
                <small>{transaction.date} · {transaction.detail}</small>
              </span>
              <span className="ledger-compact-row__impact">
                <small>예상 영향</small>
                <ToneText tone={transaction.impactTone}>
                  {transaction.impact}
                </ToneText>
              </span>
              <ToneText tone={transaction.statusTone}>
                {transaction.status}
              </ToneText>
              <b aria-hidden="true">→</b>
            </button>
          ))}
          {reviewTransactions.length === 0 && (
            <div className="ledger-empty-state" role="status">
              {heldTransactions.length > 0
                ? `검토 대기 항목은 없지만 보류 ${heldTransactions.length}건이 남아 있습니다.`
                : '모든 검토가 완료되었습니다. 결과·근거 단계로 이동할 수 있습니다.'}
            </div>
          )}
        </div>
      </section>
    </section>
  )
}

function JourneyWorkspace({
  expanded,
  transaction,
}: {
  expanded: boolean
  transaction: LedgerTransaction
}) {
  const steps = expanded
    ? transaction.journey.steps
    : transaction.journey.steps.filter((step) =>
        ['source', 'interpretation', 'valuation'].includes(step.key),
      )

  return (
    <section className="ledger-workspace ledger-state-workspace">
      <p className="ledger-state-eyebrow">
        {expanded ? 'CONFIRMED JOURNEY' : 'JOURNEY SUMMARY'}
      </p>
      <h2>
        {transaction.title} · {transaction.occurredAt.slice(0, 10)}
      </h2>
      <p className="ledger-state-description">
        {expanded
          ? '이 거래에 연결된 원본, 관찰, revision, posting, 평가, 발행 상태를 실제 mock 참조 ID로 추적합니다.'
          : '선택한 거래의 핵심 근거만 펼쳤습니다. 다른 확인 거래를 선택하면 해당 거래의 ID와 일시로 교체됩니다.'}
      </p>
      <article className="ledger-state-notice">
        <h3>{transaction.journey.economicEventId}</h3>
        <p>
          {transaction.journey.sourceRecordId} → {transaction.journey.eventId} →{' '}
          {transaction.journey.currentRevisionId}
        </p>
      </article>
      <div className="ledger-state-rows">
        {steps.map((step) => (
          <article key={step.evidenceId}>
            <i />
            <span>
              <strong>{step.label}</strong>
              <small>
                {step.detail} · {step.evidenceId}
              </small>
            </span>
            <ToneText tone={step.tone}>{step.status}</ToneText>
          </article>
        ))}
      </div>
    </section>
  )
}

function SourceWorkspace({ transaction }: { transaction: LedgerTransaction }) {
  const sourceStep = transaction.journey.steps.find(
    (step) => step.key === 'source',
  )

  return (
    <section className="ledger-workspace ledger-state-workspace">
      <p className="ledger-state-eyebrow">READ-ONLY SOURCE</p>
      <h2>{transaction.title} 원본</h2>
      <p className="ledger-state-description">
        원본은 수정하지 않으며, 사용자 판단은 별도 revision에만 기록됩니다.
      </p>
      <article className="ledger-state-notice">
        <h3>{sourceStep?.detail}</h3>
        <p>
          {transaction.occurredAt} · {transaction.journey.sourceArtifactId}
        </p>
      </article>
      <div className="ledger-state-rows">
        <article>
          <i />
          <span>
            <strong>원본 레코드</strong>
            <small>{transaction.journey.sourceRecordId}</small>
          </span>
          <ToneText tone="positive">읽기 전용</ToneText>
        </article>
        <article>
          <i />
          <span>
            <strong>관찰 연결</strong>
            <small>{transaction.journey.observationIds.join(', ')}</small>
          </span>
          <ToneText tone="positive">일치</ToneText>
        </article>
      </div>
    </section>
  )
}

function HoldWorkspace({
  onResume,
  transactions,
}: {
  onResume: (transaction: LedgerTransaction) => void
  transactions: LedgerTransaction[]
}) {
  const heldTransactions = transactions.filter(
    (transaction) => transaction.statusCode === 'on_hold',
  )

  return (
    <section className="ledger-workspace ledger-state-workspace ledger-hold-workspace">
      <p className="ledger-state-eyebrow">WORKSPACE STATE</p>
      <h2>나중에 확인하기로 한 항목입니다</h2>
      <p className="ledger-state-description">
        보류한 항목은 검토 필요 건수와 분리되며, 선택하면 같은 질문과 근거를
        복원합니다.
      </p>
      <article className="ledger-state-notice">
        <h3>검토 보류 · 자동 만료 없음</h3>
        <p>근거가 준비되면 아래 거래를 눌러 해당 질문부터 다시 시작할 수 있습니다.</p>
      </article>
      <div className="ledger-hold-list">
        {heldTransactions.map((transaction) => (
          <button
            type="button"
            key={transaction.id}
            className="ledger-hold-row"
            onClick={() => onResume(transaction)}
          >
            <span>
              <strong>
                {transaction.title} · {transaction.date}
              </strong>
              <small>{transaction.reviewTask?.prompt}</small>
            </span>
            <span>
              <small>보류 사유</small>
              <b>{transaction.reviewTask?.reasonCode}</b>
            </span>
            <em>검토 재개 →</em>
          </button>
        ))}
      </div>
      {heldTransactions.length === 0 && (
        <div className="ledger-empty-state" role="status">
          보류된 거래가 없습니다.
        </div>
      )}
    </section>
  )
}

function StateWorkspace({
  state,
  transactions,
}: {
  state: LedgerFlowState
  transactions: LedgerTransaction[]
}) {
  const mock = getRuntimeStateMock(state, transactions)

  return (
    <section className="ledger-workspace ledger-state-workspace">
      <p className="ledger-state-eyebrow">WORKSPACE STATE</p>
      <h2>{mock.title}</h2>
      <p className="ledger-state-description">{mock.description}</p>
      <article className="ledger-state-notice">
        <h3>{mock.noticeTitle}</h3>
        <p>{mock.noticeBody}</p>
      </article>
      <div className="ledger-state-rows">
        {mock.rows.map((row) => (
          <article key={`${row.label}-${row.status}`}>
            <i />
            <span>
              <strong>{row.label}</strong>
              <small>{row.detail}</small>
            </span>
            <ToneText tone={row.tone}>{row.status}</ToneText>
          </article>
        ))}
      </div>
    </section>
  )
}

function LedgerContent({
  onHoldResume,
  onReviewHold,
  onReviewSubmit,
  state,
  onMove,
  onTransactionSelect,
  reviewResult,
  reviewCount,
  selectedTransaction,
  transactions,
}: {
  onHoldResume: (transaction: LedgerTransaction) => void
  onReviewHold: () => void
  onReviewSubmit: (optionId: string) => void
  state: LedgerFlowState
  onMove: (state: LedgerFlowState) => void
  onTransactionSelect: (transaction: LedgerTransaction) => void
  reviewResult: LedgerReviewResult | null
  reviewCount: number
  selectedTransaction: LedgerTransaction
  transactions: LedgerTransaction[]
}) {
  if (state === 'A') {
    return (
      <TransactionsWorkspace
        onTransactionSelect={onTransactionSelect}
        transactions={transactions}
      />
    )
  }
  if (state === 'B') {
    return (
      <ReviewWorkspace
        key={selectedTransaction.id}
        onHold={onReviewHold}
        onMove={onMove}
        onSubmit={onReviewSubmit}
        reviewCount={reviewCount}
        transaction={selectedTransaction}
      />
    )
  }
  if (state === 'A+' || state === 'J') {
    return (
      <JourneyWorkspace
        expanded={state === 'J'}
        transaction={selectedTransaction}
      />
    )
  }
  if (state === 'D') {
    return <SourceWorkspace transaction={selectedTransaction} />
  }
  if (state === 'P') {
    return (
      <HoldWorkspace
        onResume={onHoldResume}
        transactions={transactions}
      />
    )
  }
  if (state === 'C') {
    return (
      <RevisionWorkspace
        onMove={onMove}
        onTransactionSelect={onTransactionSelect}
        reviewResult={reviewResult}
        transactions={transactions}
      />
    )
  }
  return <StateWorkspace state={state} transactions={transactions} />
}

export function LedgerPage() {
  const initialResponse = useMemo(() => readMockLedgerTransactions(), [])
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')
  const [state, setState] = useState<LedgerFlowState>('A')
  const [transactions, setTransactions] = useState(initialResponse.data.items)
  const [selectedTransactionId, setSelectedTransactionId] = useState(
    getFirstTransaction(initialResponse.data.items).id,
  )
  const [reviewResult, setReviewResult] = useState<LedgerReviewResult | null>(null)
  const reviewCount = transactions.filter(isReviewTransaction).length
  const holdCount = transactions.filter(
    (transaction) => transaction.statusCode === 'on_hold',
  ).length
  const ledgerResult = deriveMockLedgerResult(transactions)
  const hasUnresolvedReview = reviewCount > 0 || holdCount > 0
  const selectedTransaction =
    transactions.find((transaction) => transaction.id === selectedTransactionId) ??
    getFirstTransaction(transactions)

  function moveTo(nextState: LedgerFlowState) {
    if (
      hasUnresolvedReview &&
      (nextState === 'E' ||
        nextState === 'G' ||
        nextState === 'G1' ||
        nextState === 'OK')
    ) {
      return
    }

    if (nextState === 'F' && ledgerResult.resolvedReviewCount === 0) {
      return
    }

    if (nextState === 'OK') {
      publishMockLedgerSnapshot(transactions)
    }

    if (nextState === 'B') {
      const heldTransaction =
        state === 'P'
          ? transactions.find(
              (transaction) => transaction.statusCode === 'on_hold',
            )
          : undefined

      if (heldTransaction) {
        const resumedTransactions = resumeMockLedgerReview(
          transactions,
          heldTransaction.id,
        )
        setTransactions(resumedTransactions)
        setSelectedTransactionId(heldTransaction.id)
        setState('B')
        document.documentElement.scrollTop = 0
        return
      }

      const current = transactions.find(
        (transaction) => transaction.id === selectedTransactionId,
      )
      const nextReview = current && isReviewTransaction(current)
        ? current
        : transactions.find(isReviewTransaction)

      if (!nextReview) {
        setState('C0')
        document.documentElement.scrollTop = 0
        return
      }

      setSelectedTransactionId(nextReview.id)
    }

    setState(nextState)
    document.documentElement.scrollTop = 0
  }

  function handleTransactionSelect(transaction: LedgerTransaction) {
    setSelectedTransactionId(transaction.id)
    setState(transaction.confirmed ? 'A+' : 'B')
    document.documentElement.scrollTop = 0
  }

  function handleReviewSubmit(optionId: string) {
    const response = submitMockLedgerReview(
      transactions,
      selectedTransaction.id,
      optionId,
    )
    setTransactions(response.transactions)
    setReviewResult(response.result)
    setState(
      response.result.transaction.statusCode === 'on_hold' ? 'P' : 'C',
    )
    document.documentElement.scrollTop = 0
  }

  function handleReviewHold() {
    const nextTransactions = holdMockLedgerReview(
      transactions,
      selectedTransaction.id,
    )
    setTransactions(nextTransactions)
    setReviewResult(null)
    setState('P')
    document.documentElement.scrollTop = 0
  }

  function handleHoldResume(transaction: LedgerTransaction) {
    const nextTransactions = resumeMockLedgerReview(
      transactions,
      transaction.id,
    )
    setTransactions(nextTransactions)
    setSelectedTransactionId(transaction.id)
    setReviewResult(null)
    setState('B')
    document.documentElement.scrollTop = 0
  }

  return (
    <div className="ledger-page">
      <LedgerSidebar
        currentState={state}
        holdCount={holdCount}
        onStateChange={moveTo}
        onYearChange={setSelectedYear}
        resolvedReviewCount={ledgerResult.resolvedReviewCount}
        reviewCount={reviewCount}
        year={selectedYear}
      />
      <main className="ledger-main">
        <PageHeader
          description="연결부터 검증까지 한 곳에서 순서대로 진행합니다."
          eyebrow="LEDGER WORKSPACE"
          title={`${selectedYear} 장부 만들기`}
          tone="workspace"
        />

        <LedgerPipeline
          holdCount={holdCount}
          reviewCount={reviewCount}
          state={state}
          transactions={transactions}
        />

        <div className="ledger-content-grid">
          <LedgerContent
            onHoldResume={handleHoldResume}
            onMove={moveTo}
            onReviewHold={handleReviewHold}
            onReviewSubmit={handleReviewSubmit}
            onTransactionSelect={handleTransactionSelect}
            reviewResult={reviewResult}
            reviewCount={reviewCount}
            selectedTransaction={selectedTransaction}
            state={state}
            transactions={transactions}
          />
          <div className="ledger-content-asides">
            <ResultSummary
              holdCount={holdCount}
              reviewCount={reviewCount}
              reviewResult={reviewResult}
              selectedTransaction={selectedTransaction}
              state={state}
              transactions={transactions}
            />
            <NextActionCard
              holdCount={holdCount}
              onMove={moveTo}
              reviewCount={reviewCount}
              state={state}
            />
          </div>
        </div>
      </main>
    </div>
  )
}
