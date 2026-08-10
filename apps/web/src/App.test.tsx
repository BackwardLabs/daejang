import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App.tsx'

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/capabilities')) {
        return new Response(JSON.stringify({
          signup: {
            enabled: true,
            identityVerificationRequired: true,
            methods: {
              email: true,
              oauthProviders: ['kakao', 'naver', 'google'],
            },
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      throw new Error(`Unexpected request: ${String(input)}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('App', () => {
  it('renders the landing page with product sections and real preview images', () => {
    render(<App />)

    expect(screen.getAllByRole('link', { name: 'Daejang 홈' })).toHaveLength(2)
    expect(
      screen.getByRole('heading', {
        name: /흩어진 디지털 자산 기록,.*한곳에서/,
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '기록이 보고서가 되는 네 단계' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '자주 묻는 질문' }),
    ).toBeInTheDocument()
    const collectSection = screen.getByRole('region', {
      name: /거래소와 개인지갑 기록/,
    })
    expect(
      within(collectSection).queryByRole('link', { name: '수집 흐름 보기' }),
    ).not.toBeInTheDocument()
    expect(
      within(collectSection).queryByRole('link', { name: '지원 범위' }),
    ).not.toBeInTheDocument()
    const supportScope = within(collectSection).getByRole('region', {
      name: '현재 지원 범위',
    })
    const supportedDocuments = within(supportScope).getByRole('list', {
      name: '지원 거래 자료',
    })
    expect(
      within(supportedDocuments).getByText('Upbit 거래 내역서'),
    ).toBeInTheDocument()
    expect(
      within(supportScope).getByText('지원 기간은 지속적으로 확장 중입니다.'),
    ).toBeInTheDocument()
    expect(
      within(supportScope).getByText('대한민국 표준시(KST, UTC+9) 기준'),
    ).toBeInTheDocument()
    const collectionPeriods = within(supportScope).getByRole('list', {
      name: '지원 네트워크와 수집 기간',
    })
    const ethereumPeriod = within(collectionPeriods).getByRole('listitem', {
      name: 'Ethereum mainnet',
    })
    expect(
      within(ethereumPeriod).getByText('2015-07-31 00:26:28'),
    ).toBeInTheDocument()
    expect(
      within(ethereumPeriod).getByText('2026-07-18 19:56:23'),
    ).toBeInTheDocument()
    expect(
      within(ethereumPeriod).queryByText('2022-09-15 15:42:59'),
    ).not.toBeInTheDocument()
    const optimismPeriod = within(collectionPeriods).getByRole('listitem', {
      name: 'Optimism mainnet',
    })
    expect(
      within(optimismPeriod).getByText('2021-11-12 06:16:39'),
    ).toBeInTheDocument()
    expect(
      within(optimismPeriod).getByText('2026-07-20 15:33:19'),
    ).toBeInTheDocument()
    const giwaPeriod = within(collectionPeriods).getByRole('listitem', {
      name: 'GIWA Sepolia',
    })
    expect(
      within(giwaPeriod).getByText('2025-07-24 17:18:36'),
    ).toBeInTheDocument()
    expect(within(supportScope).queryByText('수집')).not.toBeInTheDocument()
    expect(within(supportScope).queryByText('미수집')).not.toBeInTheDocument()
    expect(within(supportScope).queryByText('추후 안내 예정')).not.toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: '대장의 자산 현황, 소스별 보유량과 보유 자산을 보여주는 대시보드',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('img', {
        name: '대장의 검토 반영 결과와 보고서 생성 근거를 보여주는 제품 화면',
      }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      'https://daejang.backwardlabs.io/docs',
    )
  })

  it('keeps the FAQ accordion single-open', () => {
    render(<App />)

    const firstQuestion = screen.getByRole('button', {
      name: '기존 계정이 있다고 표시되는 이유는 무엇인가요?',
    })
    const secondQuestion = screen.getByRole('button', {
      name: '본인확인이 계속 실패하는 이유는 무엇인가요?',
    })

    fireEvent.click(firstQuestion)
    expect(
      screen.getByText(/같은 본인확인 정보나/),
    ).toBeInTheDocument()

    fireEvent.click(secondQuestion)
    expect(
      screen.queryByText(/같은 본인확인 정보나/),
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(/이름과 휴대전화 명의가/),
    ).toBeInTheDocument()
  })
})
