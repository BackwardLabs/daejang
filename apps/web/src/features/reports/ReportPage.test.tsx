import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  publishMockLedgerSnapshot,
  readMockLedgerTransactions,
  submitMockLedgerReview,
} from '../../mocks/ledger.ts'
import { createMockReports } from '../../mocks/reports.ts'
import { ReportPage } from './ReportPage.tsx'

describe('ReportPage', () => {
  it('uses the ledger revision result for rev.3 and rev.4 profit values', () => {
    const reports = createMockReports(readMockLedgerTransactions().data.items)
    const rev4 = reports.find((report) => report.revision === 'rev.4')
    const rev3 = reports.find((report) => report.revision === 'rev.3')

    expect(rev4?.profitWon).toBe(875_000)
    expect(rev3?.profitWon).toBe(720_000)
  })

  it('derives the latest report from the persisted ledger transactions', () => {
    const response = readMockLedgerTransactions()
    const btcReview = response.data.items.find(
      (transaction) => transaction.id === 'btc-sell',
    )
    const confirmedOption = btcReview?.reviewTask?.options.find(
      (option) => option.outcome === 'confirmed',
    )

    if (!btcReview || !confirmedOption) {
      throw new Error('BTC review fixture is required.')
    }

    submitMockLedgerReview(
      response.data.items,
      btcReview.id,
      confirmedOption.id,
    )
    render(<ReportPage />)

    expect(screen.getByText('완전 11 · 예외 13')).toBeInTheDocument()
    expect(screen.getByText('24건')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '2027 장부 · rev.5' }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('+1,055,000원').length).toBeGreaterThan(0)
  })

  it('renders Figma report history, outputs, and GIWA integrity details', () => {
    render(<ReportPage />)

    expect(
      screen.getByRole('heading', { name: '작업본 · 발행 내역' }),
    ).toBeInTheDocument()
    expect(screen.getByText(/현재 작업본 · 미발행/)).toBeInTheDocument()
    expect(
      screen.getByText('아직 발행되지 않음 · 검증 대기'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /PDF 요약/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /PDF 요약/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /CSV 상세/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /JSON ledger/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Manifest/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Evidence Pack/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '웹으로 보기' })).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: /2027 · rev.3/ }))
    expect(screen.getByText(/이전 발행 snapshot/)).toBeInTheDocument()
    expect(screen.getByText('GIWA에 기록됨 · 일치')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '웹으로 보기' })).toBeEnabled()

    fireEvent.change(screen.getByRole('combobox', { name: '조회 기간' }), {
      target: { value: '2026' },
    })

    expect(
      screen.getByRole('heading', { name: '2026 장부 · rev.2' }),
    ).toBeInTheDocument()
    expect(screen.getByText('5건')).toBeInTheDocument()
  })

  it('opens the data-linked web report and tax advisor share format', () => {
    publishMockLedgerSnapshot(readMockLedgerTransactions().data.items)
    render(<ReportPage />)

    fireEvent.click(screen.getByRole('button', { name: '웹으로 보기' }))
    expect(
      screen.getByRole('dialog', { name: '2027 세무 검토용 장부' }),
    ).toBeInTheDocument()
    expect(screen.getByText('snapshot.2027.rev.4')).toBeInTheDocument()
    expect(screen.getByText(/지갑 주소와 원본 거래 식별자를 표시하지 않습니다/))
      .toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '발행 내역으로' }))

    fireEvent.click(screen.getByRole('button', { name: '세무사에게 공유' }))
    expect(
      screen.getByRole('dialog', { name: '세무사에게 보고서 공유' }),
    ).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(/받는 사람 이메일/), {
      target: { value: 'tax@example.com' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '제한된 공유 링크 만들기' }),
    )

    expect(screen.getByText('공유 링크가 준비되었습니다')).toBeInTheDocument()
    expect(screen.getByDisplayValue(/shared\/reports\/share-2027-rev-4/))
      .toBeInTheDocument()
  })
})
