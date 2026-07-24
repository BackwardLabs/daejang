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
    ).toHaveAttribute('href', '/sources/new')

    const period = screen.getByRole('combobox', { name: '조회 기간' })
    expect(period).toHaveValue('2027')
    expect(screen.queryByText('2027 과세연도')).not.toBeInTheDocument()

    fireEvent.change(period, { target: { value: '2026' } })

    expect(period).toHaveValue('2026')
    expect(screen.queryByText('2026 과세연도')).not.toBeInTheDocument()

    unmount()
    render(<SourceTypeSelectionPage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
    expect(screen.queryByText('2026 과세연도')).not.toBeInTheDocument()
  })

  it('offers only the documented Upbit PDF and EVM public-address methods', () => {
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
    ).toHaveAttribute('href', '/sources/new/upbit')
    expect(
      within(methods).getByRole('link', { name: 'EVM 공개 주소 선택' }),
    ).toHaveAttribute('href', '/sources/new/wallet')
    expect(
      within(methods).getByText('암호화되지 않은 PDF 지원'),
    ).toBeInTheDocument()
    expect(
      within(methods).getByText('새 거래는 최신 PDF를 다시 등록'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Upbit는 PDF 업로드, EVM은 공개 주소 읽기 방식으로 연결합니다.',
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
      screen.getByText(/MVP에서는 암호화되지 않은 Upbit 거래내역서 PDF만/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/PDF 비밀번호/)).not.toBeInTheDocument()

    expect(
      screen.getByRole('link', { name: 'PDF 등록 시작' }),
    ).toHaveAttribute('href', '/app/sources/new/upbit/upload')
    expect(
      screen.getByRole('link', { name: '연결 방식 다시 선택' }),
    ).toHaveAttribute('href', '/sources/new')
  })

  it('keeps EVM registration read-only and does not request wallet secrets', () => {
    render(<SourceMethodIntroPage methodId="evm-address" />)

    expect(
      screen.getByRole('heading', { name: 'EVM 공개 주소 등록' }),
    ).toBeInTheDocument()
    const flow = screen.getByRole('complementary', {
      name: 'EVM Wallet 등록 흐름',
    })
    expect(within(flow).getByText('공개 주소 등록')).toBeInTheDocument()
    expect(within(flow).getByText('수집 범위 확인')).toBeInTheDocument()
    expect(within(flow).getByText('수집 전 확인')).toBeInTheDocument()
    expect(
      screen.getByText(/소유권 확인 서명을 요구하거나 저장하지 않습니다/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    const startButton = screen.getByRole('button', {
      name: '공개 주소 등록 시작',
    })
    expect(startButton).toBeDisabled()
    expect(startButton).toHaveAccessibleDescription(
      '입력·업로드 단계는 다음 stacked PR에서 연결됩니다.',
    )
  })
})
