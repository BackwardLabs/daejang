import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceManagementPage } from './SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './SourceTypeSelectionPage.tsx'

afterEach(() => vi.unstubAllGlobals())

describe('source flow pages', () => {
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
    expect(screen.getByText('현재 연결된 소스 0개')).toBeInTheDocument()
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

  it('uses production-safe copy when source services are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'WALLET_SOURCE_UNAVAILABLE' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )))

    render(<SourceManagementPage />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '데이터 소스를 잠시 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.',
    )
    expect(screen.queryByText(/로컬 데이터베이스/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '아직 연결된 데이터 소스가 없어요' }),
    ).not.toBeInTheDocument()
  })

  it('shows failed collection details and starts a new tracked job', async () => {
    const source = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'EVM_WALLET',
      address: '0x239000000000000000000000000000000000f2b2',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-01-01T00:00:00.000Z',
      label: 'EVM Wallet',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    const failedJob = {
      id: '55555555-5555-4555-8555-555555555555',
      sourceId: source.id,
      sourceKind: 'EVM_WALLET',
      state: 'FAILED',
      phase: 'VALIDATE_SOURCE',
      attempts: 3,
      processedRecords: 0,
      failureCode: 'JIT_START_FAILED',
      failureMessage: 'JIT 실행 요청에 실패했습니다.',
      requestedCoverageStart: '2027-01-01',
      requestedCoverageEnd: '2027-12-31',
      trigger: 'USER_REQUEST',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:05:00.000Z',
    }
    const queuedJob = {
      ...failedJob,
      id: '66666666-6666-4666-8666-666666666666',
      state: 'QUEUED',
      phase: 'QUEUED',
      attempts: 0,
      failureCode: undefined,
      failureMessage: undefined,
      updatedAt: '2027-01-01T00:06:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/sources') {
        return new Response(JSON.stringify({ items: [source] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/v1/jobs') {
        return new Response(JSON.stringify({ items: [failedJob] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `/api/v1/jobs/${failedJob.id}/retry`) {
        return new Response(JSON.stringify({ job: queuedJob }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `/api/v1/jobs/${queuedJob.id}`) {
        return new Response(JSON.stringify({
          job: { ...queuedJob, state: 'SUCCEEDED', phase: 'COMPLETE' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SourceManagementPage />)

    const statusButton = await screen.findByRole('button', {
      name: /처리 확인 필요 · JIT_START_FAILED/,
    })
    fireEvent.click(statusButton)

    expect(
      screen.getByRole('heading', { name: '수집 문제를 확인해 주세요' }),
    ).toBeInTheDocument()
    expect(screen.getByText('JIT 실행 요청에 실패했습니다.')).toBeInTheDocument()
    expect(screen.getByText('JIT_START_FAILED')).toBeInTheDocument()
    expect(screen.getByText('2027-01-01 – 2027-12-31')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 수집' }))

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /처리 완료.*장부 보기/ }),
      ).toHaveAttribute('href', '/ledger')
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/jobs/${failedJob.id}/retry`,
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"intentKey":"source-retry:'),
      }),
    )
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
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()

    expect(
      screen.getByRole('link', { name: '지갑 연결 시작' }),
    ).toHaveAttribute('href', '/sources/new/wallet')
  })
})
