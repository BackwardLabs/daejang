import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SourceManagementPage } from './SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './SourceTypeSelectionPage.tsx'

describe('source flow pages', () => {
  it('starts from an empty source list and keeps the selected tax year in sync', () => {
    const { unmount } = render(<SourceManagementPage />)

    expect(
      screen.getByRole('heading', { name: '데이터 소스 관리' }),
    ).toBeInTheDocument()
    expect(screen.getByText('현재 연결된 소스 0개')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByRole('link', { name: '데이터 소스 추가' }),
    ).toHaveLength(2)
    expect(
      screen.getAllByRole('link', { name: '데이터 소스 추가' })[0],
    ).toHaveAttribute('href', '/app/sources/new')

    const period = screen.getByRole('combobox', { name: '조회 기간' })
    expect(period).toHaveValue('2027')
    expect(screen.getByText('2027 과세연도')).toBeInTheDocument()

    fireEvent.change(period, { target: { value: '2026' } })

    expect(period).toHaveValue('2026')
    expect(screen.getByText('2026 과세연도')).toBeInTheDocument()

    unmount()
    render(<SourceTypeSelectionPage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
    expect(screen.getByText('2026 과세연도')).toBeInTheDocument()
  })

  it('offers only the documented Upbit PDF and EVM Wallet methods', () => {
    render(<SourceTypeSelectionPage />)

    const methods = screen.getByRole('region', {
      name: '데이터 소스 연결 방식',
    })

    expect(
      within(methods).getByRole('heading', { name: 'Upbit 거래내역서' }),
    ).toBeInTheDocument()
    expect(
      within(methods).getByRole('heading', { name: 'EVM Wallet' }),
    ).toBeInTheDocument()
    expect(
      within(methods).getByRole('link', { name: 'Upbit PDF 선택' }),
    ).toHaveAttribute('href', '/app/sources/new/upbit')
    expect(
      within(methods).getByRole('link', { name: 'EVM Wallet 선택' }),
    ).toHaveAttribute('href', '/app/sources/new/wallet')
    expect(
      within(methods).getByText('암호화 PDF는 비밀번호로 처리'),
    ).toBeInTheDocument()
    expect(
      within(methods).getByText('새 거래는 최신 PDF를 다시 등록'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Upbit는 PDF 업로드, EVM은 브라우저 지갑의 읽기 전용 연결 방식으로 등록합니다.',
      ),
    ).toBeInTheDocument()
    expect(
      within(methods).getByText(
        /소유권 확인 서명은 거래나 자산 이동을 승인하지 않습니다/,
      ),
    ).toBeInTheDocument()
  })

  it('explains the Upbit PDF flow and links to registration', () => {
    render(<SourceMethodIntroPage methodId="upbit-pdf" />)

    expect(
      screen.getByRole('heading', { name: 'Upbit PDF 등록' }),
    ).toBeInTheDocument()
    const flow = screen.getByRole('complementary', {
      name: 'Upbit 거래내역서 등록 흐름',
    })
    expect(within(flow).getByText('PDF 선택')).toBeInTheDocument()
    expect(within(flow).getByText('등록 정보 확인')).toBeInTheDocument()
    expect(within(flow).getByText('등록 완료')).toBeInTheDocument()
    expect(
      screen.getByText(/Upbit PDF는 자동 동기화되지 않습니다/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/암호화된 PDF의 비밀번호는 파일 처리에만 사용하고/),
    ).toBeInTheDocument()
    expect(
      within(flow).getByText(/PDF 비밀번호는 파일 처리에만 사용하고/),
    ).toBeInTheDocument()

    expect(
      screen.getByRole('link', { name: 'PDF 등록 시작' }),
    ).toHaveAttribute('href', '/app/sources/new/upbit/upload')
    expect(
      screen.getByRole('link', { name: '연결 방식 다시 선택' }),
    ).toHaveAttribute('href', '/app/sources/new')
  })

  it('explains the read-only EVM Wallet connection and links to the connection flow', () => {
    render(<SourceMethodIntroPage methodId="evm-wallet" />)

    expect(
      screen.getByRole('heading', { name: 'EVM Wallet 연결' }),
    ).toBeInTheDocument()
    const flow = screen.getByRole('complementary', {
      name: 'EVM Wallet 등록 흐름',
    })
    expect(within(flow).getByText('지갑 연결')).toBeInTheDocument()
    expect(within(flow).getByText('수집 범위 확인')).toBeInTheDocument()
    expect(within(flow).getByText('연결 완료')).toBeInTheDocument()
    expect(
      screen.getByText(/가스비가 없는 오프체인 메시지 서명/),
    ).toBeInTheDocument()
    expect(
      within(flow).getByText(
        /private key·seed phrase·쓰기·출금 권한을 요청하거나 저장하지 않습니다/,
      ),
    ).toBeInTheDocument()
    expect(
      within(flow).getByText(
        /오프체인 서명은 지갑 소유권 확인에만 사용합니다/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    expect(
      screen.getByRole('link', { name: '지갑 연결 시작' }),
    ).toHaveAttribute('href', '/app/sources/new/wallet/connect')
  })
})
