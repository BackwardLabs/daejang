import { fireEvent, render, screen, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceManagementPage } from './SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './SourceTypeSelectionPage.tsx'
import { queueWalletRegistrationNotice } from './sourceRegistrationNotice.ts'

vi.mock('./ReownEvmWalletConnectionRoute.tsx', () => ({
  ReownWalletLauncher: ({
    onConnected,
    onCancelled,
  }: {
    onConnected: (wallet: {
      address: string
      chainId: string
      network: string
      provider: 'walletconnect'
    }) => void
    onCancelled?: () => void
  }) => (
    <div role="dialog" aria-label="Reown 지갑 연결">
      <button
        type="button"
        onClick={() => onConnected({
          address: '0x1234567890abcdef1234567890abcdef12345678',
          chainId: 'eip155:1',
          network: 'Ethereum',
          provider: 'walletconnect',
        })}
      >
        연결 완료 시뮬레이션
      </button>
      <button type="button" onClick={onCancelled}>
        서명 취소 시뮬레이션
      </button>
    </div>
  ),
}))

afterEach(() => vi.unstubAllGlobals())

describe('source flow pages', () => {
  it('keeps the source list structure visible while data is loading', () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise(() => {})))

    render(<SourceManagementPage />)

    expect(screen.getByText('현재 연결된 소스 —')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '연결된 데이터 소스 목록' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      '데이터 소스를 불러오는 중입니다.',
    )
  })

  it('starts from an empty source list and keeps the selected tax year in sync', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )))
    const { unmount } = render(<SourceManagementPage />)

    expect(
      screen.getByRole('heading', { name: '데이터 소스 관리' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText('현재 연결된 소스 0개'),
    ).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', {
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

  it('shows registered sources even when job status is temporarily unavailable', async () => {
    const walletSource = {
      id: 'source-wallet-1',
      type: 'EVM_WALLET',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-07-29T00:00:00.000Z',
      status: 'ACTIVE',
      createdAt: '2027-07-29T00:00:00.000Z',
      updatedAt: '2027-07-29T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ items: [walletSource] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          error: { code: 'ENGINE_UNAVAILABLE' },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })),
    )

    render(<SourceManagementPage />)

    expect(await screen.findByText('현재 연결된 소스 1개')).toBeInTheDocument()
    expect(screen.getByText('0x1234…5678')).toBeInTheDocument()
    expect(screen.getByText('연결됨')).toBeInTheDocument()
  })

  it('shows a completion toast after returning from wallet registration in StrictMode', async () => {
    queueWalletRegistrationNotice()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ))

    render(
      <StrictMode>
        <SourceManagementPage />
      </StrictMode>,
    )

    expect(await screen.findByText('연결 완료')).toBeInTheDocument()
    expect(screen.getByText('지갑 데이터 소스가 등록되었습니다.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '알림 닫기' })).toBeEnabled()
  })

  it('uses production-safe copy and can retry when source services are unavailable', async () => {
    const unavailable = () => Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'WALLET_SOURCE_UNAVAILABLE' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const available = () => Promise.resolve(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn()
        .mockImplementationOnce(unavailable)
        .mockImplementationOnce(unavailable)
        .mockImplementationOnce(available)
        .mockImplementationOnce(available),
    )

    render(<SourceManagementPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '데이터 소스를 불러오지 못했습니다.',
    )
    expect(screen.getByText('현재 연결된 소스 —')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '연결된 데이터 소스 목록' }),
    ).toBeInTheDocument()
    expect(screen.queryByText(/로컬 데이터베이스/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '아직 연결된 데이터 소스가 없어요' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '데이터 소스 다시 불러오기' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('현재 연결된 소스 0개')).toBeInTheDocument()
  })

  it('keeps Upbit PDF disabled when the safe import path is unavailable', () => {
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
      within(methods).getByText('Upbit PDF 등록 불가'),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      within(methods).queryByRole('link', { name: 'Upbit PDF 선택' }),
    ).not.toBeInTheDocument()
    expect(
      within(methods).getByRole('link', { name: 'EVM Wallet 선택' }),
    ).toHaveAttribute('href', '/sources/new/wallet')
    expect(
      within(methods).getByText('암호화되지 않은 PDF 지원'),
    ).toBeInTheDocument()
    expect(
      within(methods).getByText('새 거래는 최신 PDF를 다시 등록'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Upbit는 PDF 업로드, EVM은 브라우저 지갑의 읽기 전용 연결 방식으로 등록합니다.',
      ),
    ).toBeInTheDocument()
  })

  it('explains the Upbit PDF flow without linking to a disabled registration path', () => {
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
    expect(screen.queryByText(/PDF 비밀번호/)).not.toBeInTheDocument()

    expect(
      screen.getByText('Upbit PDF 등록 불가'),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.queryByRole('link', { name: 'PDF 등록 시작' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '현재는 안전한 Upbit 문서 처리 경로가 활성화되지 않아 PDF 등록을 받을 수 없습니다.',
    )
    expect(
      screen.getByRole('link', { name: '연결 방식 다시 선택' }),
    ).toHaveAttribute('href', '/sources/new')
  })

  it('keeps the introduction behind Reown and returns to sources after registration', async () => {
    window.history.pushState({}, '', '/sources/new/wallet')
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
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '지갑 연결 시작' }),
    )

    expect(
      await screen.findByRole('dialog', { name: 'Reown 지갑 연결' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', {
        name: '지갑 주소만 연결해 온체인 거래를 수집하세요',
      }),
    ).toBeInTheDocument()
    expect(screen.getAllByText('읽기 전용')).toHaveLength(1)
    expect(window.location.pathname).toBe('/sources/new/wallet')

    fireEvent.click(
      screen.getByRole('button', { name: '연결 완료 시뮬레이션' }),
    )

    expect(
      screen.queryByRole('dialog', { name: 'Reown 지갑 연결' }),
    ).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/sources')
    expect(window.sessionStorage.getItem('source-registration-notice.v1')).toBe(
      'wallet',
    )
  })

  it('returns to the unchanged introduction and allows retry after cancellation', async () => {
    window.history.pushState({}, '', '/sources/new/wallet')
    render(<SourceMethodIntroPage methodId="evm-wallet" />)

    fireEvent.click(
      screen.getByRole('button', { name: '지갑 연결 시작' }),
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '서명 취소 시뮬레이션' }),
    )

    expect(
      screen.getByRole('heading', { name: 'EVM Wallet 연결' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '지갑 연결 또는 서명이 취소되었습니다. 다시 시도해 주세요.',
    )
    expect(
      screen.getByRole('button', { name: '지갑 연결 시작' }),
    ).toBeEnabled()
    expect(
      screen.queryByRole('dialog', { name: 'Reown 지갑 연결' }),
    ).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/sources/new/wallet')
  })
})
