import { fireEvent, render, screen } from '@testing-library/react'
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
      name: '본인확인이 계속 실패해요',
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
      screen.getByText(/이름과 휴대전화 명의를/),
    ).toBeInTheDocument()
  })
})
