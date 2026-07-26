import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  deriveMockLedgerRevisionHistory,
  ledgerTransactionsResponse,
  publishMockLedgerSnapshot,
  submitMockLedgerReview,
  validateMockLedgerTransactions,
} from '../../mocks/ledger.ts'
import { LedgerPage } from './LedgerPage.tsx'

describe('LedgerPage', () => {
  it('moves through review, hold recovery, publish, and GIWA verification', () => {
    render(<LedgerPage />)

    expect(screen.getByRole('button', { name: '결과·근거' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revision 비교' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /BTC 매도/ }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    expect(screen.getByRole('button', { name: '결과·근거' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revision 비교' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: '다음 검토 →' }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))

    expect(screen.getByRole('button', { name: '검토 모두 완료' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /보류함\s*2/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '보류 2건 확인 →' }))
    fireEvent.click(screen.getByRole('button', { name: /토큰 스왑.*검토 재개/ }))

    expect(screen.getByRole('button', { name: /보류함\s*2/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /보류함\s*2/ }))
    expect(screen.getByRole('button', { name: /토큰 스왑.*검토 재개/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /브리지 입금.*검토 재개/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /토큰 스왑.*검토 재개/ }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    expect(screen.getByRole('button', { name: /보류함\s*1/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '보류 1건 확인 →' }))
    fireEvent.click(screen.getByRole('button', { name: /브리지 입금.*검토 재개/ }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))

    const pipeline = screen.getByRole('region', { name: '장부 생성 진행 단계' })
    const reviewStep = within(pipeline).getByText('검토').closest('li')

    expect(reviewStep).toHaveAttribute('data-status', 'complete')
    expect(reviewStep).toHaveClass('is-complete')
    expect(reviewStep?.querySelector('i')).toHaveTextContent('✓')
    expect(screen.getByRole('button', { name: '결과·근거' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '검토 모두 완료' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '검토 모두 완료' }))

    expect(screen.getAllByText('11 / 11').length).toBeGreaterThan(0)
    expect(screen.getByText('표시 전용 3건은 예외로 남겨 두고 산출물에 함께 기록합니다.'))
      .toBeInTheDocument()
    expect(screen.queryByText('Coverage 7 / 7')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '발행 준비 →' }))

    expect(screen.getByText('24개 거래 · 손익 +1,650,000원')).toBeInTheDocument()
    expect(screen.getByText('24행 · 합계 일치')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '불일치 예시 보기' }))
    expect(screen.getByText('CSV 합계 · 32,000원 차이')).toBeInTheDocument()
    expect(screen.getByText('+1,618,000원')).toBeInTheDocument()
    expect(screen.getByText('+1,650,000원')).toBeInTheDocument()
    expect(screen.getByText('rev.15 · policy v1.3')).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: '발행 준비로 돌아가기 →' }),
    )

    fireEvent.click(screen.getByRole('button', { name: '발행 후 검증 →' }))

    expect(
      screen.getByRole('heading', {
        name: 'GIWA commitment와 모든 산출물이 일치합니다',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText(/거래 24건 및 손익 \+1,650,000원이 일치합니다/))
      .toBeInTheDocument()
  })

  it('supports original evidence, hold, and revision comparison branches', () => {
    render(<LedgerPage />)

    fireEvent.click(screen.getByRole('button', { name: /BTC 매도/ }))
    fireEvent.click(screen.getByRole('button', { name: '원본 보기' }))
    expect(
      screen.getByRole('heading', { name: 'BTC 매도 원본' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '사실 확인으로 →' }))

    fireEvent.click(screen.getByRole('button', { name: '나중에' }))
    fireEvent.click(screen.getByRole('button', { name: /BTC 매도.*검토 재개/ }))
    expect(
      screen.getByText('사유 코드 · LOT_ACQUISITION_SOURCE_REQUIRED'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /보류함\s*3/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    fireEvent.click(screen.getByRole('button', { name: 'revision 비교' }))
    expect(
      screen.getByRole('heading', { name: 'revision 변경 전후를 비교합니다' }),
    ).toBeInTheDocument()
    const partialPipeline = screen.getByRole('region', {
      name: '장부 생성 진행 단계',
    })
    const partialReviewStep = within(partialPipeline).getByText('검토').closest('li')

    expect(partialReviewStep).toHaveAttribute('data-status', 'active')
    expect(partialReviewStep).not.toHaveClass('is-complete')
    expect(screen.getAllByText('rev.5').length).toBeGreaterThan(0)
    expect(screen.getAllByText('rev.4').length).toBeGreaterThan(0)
    expect(
      screen.getByText(/보고서 생성은 현재 revision을 별도 발행 snapshot으로 고정/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '검토 계속 →' })).toBeEnabled()
    expect(
      screen.queryByRole('button', { name: 'rev.4로 되돌리기' }),
    ).not.toBeInTheDocument()
  })

  it('keeps every confirmed review revision and does not increment on publication', () => {
    const initial = ledgerTransactionsResponse.data.items.map((transaction) => ({
      ...transaction,
      journey: {
        ...transaction.journey,
        steps: transaction.journey.steps.map((step) => ({ ...step })),
      },
      reviewTask: transaction.reviewTask
        ? {
            ...transaction.reviewTask,
            options: transaction.reviewTask.options.map((option) => ({
              ...option,
            })),
          }
        : undefined,
    }))
    const firstReview = initial.find(
      (transaction) => transaction.reviewTask?.status === 'OPEN',
    )

    expect(firstReview).toBeDefined()
    const firstOption = firstReview?.reviewTask?.options.find(
      (option) => option.outcome === 'confirmed',
    )
    expect(firstOption).toBeDefined()

    const afterFirst = submitMockLedgerReview(
      initial,
      firstReview!.id,
      firstOption!.id,
    ).transactions
    const secondReview = afterFirst.find(
      (transaction) => transaction.reviewTask?.status === 'OPEN',
    )
    const secondOption = secondReview?.reviewTask?.options.find(
      (option) => option.outcome === 'confirmed',
    )

    expect(secondReview).toBeDefined()
    expect(secondOption).toBeDefined()

    const afterSecond = submitMockLedgerReview(
      afterFirst,
      secondReview!.id,
      secondOption!.id,
    ).transactions
    const history = deriveMockLedgerRevisionHistory(afterSecond)
    const publication = publishMockLedgerSnapshot(afterSecond)

    expect(history.map((snapshot) => snapshot.revision)).toEqual([
      'rev.4',
      'rev.5',
      'rev.6',
    ])
    expect(publication.revision).toBe('rev.6')
    expect(deriveMockLedgerRevisionHistory(afterSecond)).toEqual(history)
  })

  it('opens the full journey for confirmed transactions', () => {
    render(<LedgerPage />)

    fireEvent.click(screen.getByRole('button', { name: /^확인/ }))
    fireEvent.click(screen.getByRole('button', { name: /ETH 매도/ }))

    expect(
      screen.getByRole('heading', { name: 'ETH 매도 · 2027-03-12' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '전체 여정 보기 →' }))
    expect(screen.getAllByText(/source-record\.eth-sell/).length).toBeGreaterThan(0)
  })

  it('uses the shared signed-in sidebar and hides development-only controls', () => {
    render(<LedgerPage />)

    const ledgerLink = screen.getByRole('link', { name: '장부 작업' })
    expect(screen.getByText('김대장')).toBeInTheDocument()
    expect(ledgerLink).toHaveAttribute('aria-current', 'page')
    expect(ledgerLink.closest('li')?.nextElementSibling).toContainElement(
      screen.getByRole('navigation', { name: '장부 작업 메뉴' }),
    )
    expect(screen.queryByText('Mock 검증 도구')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '0건 흐름' })).not.toBeInTheDocument()
  })

  it('restores reviewed transactions from the local mock store after remounting', () => {
    const { unmount } = render(<LedgerPage />)

    fireEvent.click(screen.getByRole('button', { name: /BTC 매도/ }))
    fireEvent.click(screen.getByRole('button', { name: '제출 →' }))
    expect(screen.getByText('+1,055,000원')).toBeInTheDocument()
    expect(window.localStorage.length).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '거래 목록' }))
    expect(screen.getByText('+1,055,000원')).toBeInTheDocument()

    unmount()
    render(<LedgerPage />)

    expect(screen.getByText('+1,055,000원')).toBeInTheDocument()
    expect(screen.getByText('rev.5')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /BTC 매도/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^확인/ }))
    expect(screen.getByRole('button', { name: /BTC 매도/ })).toHaveTextContent(
      '확인됨',
    )
  })

  it('ships a referentially consistent validation fixture', () => {
    expect(
      validateMockLedgerTransactions(ledgerTransactionsResponse.data.items),
    ).toEqual([])
    expect(ledgerTransactionsResponse.meta.schemaVersion).toBe(
      'ledger-transactions.v5',
    )
    expect(
      ledgerTransactionsResponse.data.items.map((transaction) => transaction.id),
    ).toEqual(
      expect.arrayContaining([
        'usdt-depeg-settlement',
        'restaking-reward',
        'exchange-fee-rebate',
        'reorg-invalidated-transfer',
      ]),
    )
  })

  it('derives list, pipeline, and pagination counts from mock items', () => {
    render(<LedgerPage />)

    expect(screen.getByText('원본 24건')).toBeInTheDocument()
    expect(screen.getByText('Event 24')).toBeInTheDocument()
    expect(screen.getByText('연결 24')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '전체 24' }))

    expect(screen.getByText('1–10 / 24')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '전체 19' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2' })).toBeInTheDocument()
  })

  it('opens the review flow for the transaction row that was selected', () => {
    render(<LedgerPage />)

    fireEvent.click(
      screen.getByRole('button', {
        name: /ETH 전송.*03-10/,
      }),
    )

    expect(
      screen.getByText(/2027-03-10 · ETH 전송 · Ethereum 지갑/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('group', {
        name: /도착 지갑과 이체 당시 자산의 귀속 관계를 선택해 주세요/,
      }),
    ).toBeInTheDocument()
  })
})
