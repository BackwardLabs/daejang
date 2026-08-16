import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceManagementPage } from './SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './SourceTypeSelectionPage.tsx'

vi.mock('./ReownEvmWalletConnectionRoute.tsx', () => ({
  ReownEvmWalletConnectionRoute: () => <div>지갑 연결 내용</div>,
}))

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
    expect(screen.getByText('현재 연결된 소스 확인 중')).toBeInTheDocument()
    expect(
      await screen.findByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('현재 연결된 소스 0개')).toBeInTheDocument()
    expect(
      screen.getAllByRole('link', { name: '데이터 소스 추가' }),
    ).toHaveLength(2)
    expect(
      screen.getAllByRole('link', { name: '데이터 소스 추가' })[0],
    ).toHaveAttribute('href', '/sources/new')
    expect(
      screen.getByText(
        '각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.',
      ),
    ).toBeInTheDocument()

    const period = screen.getByRole('combobox', { name: '조회 기간' })
    expect(period).toHaveValue('2026')
    expect(screen.queryByText('2026 과세연도')).not.toBeInTheDocument()

    fireEvent.change(period, { target: { value: '2025' } })

    expect(period).toHaveValue('2025')
    expect(screen.queryByText('2025 과세연도')).not.toBeInTheDocument()

    unmount()
    render(<SourceTypeSelectionPage />)

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2025',
    )
    expect(screen.queryByText('2025 과세연도')).not.toBeInTheDocument()
  })

  it('does not report zero sources while the source count is still loading', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => undefined)),
    )

    render(<SourceManagementPage />)

    expect(screen.getByRole('status')).toHaveTextContent(
      '데이터 소스를 불러오는 중입니다',
    )
    expect(screen.getByText('현재 연결된 소스 확인 중')).toBeInTheDocument()
    expect(
      screen.queryByText('현재 연결된 소스 0개'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        '각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.',
      ),
    ).not.toBeInTheDocument()
  })

  it('hides previously disconnected sources and removes a wallet after disconnecting it', async () => {
    const activeSource = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'EVM_WALLET',
      address: '0×239000000000000000000000000000000000f2b2',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-01-01T00:00:00.000Z',
      label: '세무 지갑',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    const disconnectedSource = {
      ...activeSource,
      id: '44444444-4444-4444-8444-444444444444',
      address: '0x951000000000000000000000000000000000b14d',
      status: 'DISCONNECTED',
      disconnectedAt: '2027-01-02T00:00:00.000Z',
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/v1/sources') {
        return new Response(
          JSON.stringify({ items: [activeSource, disconnectedSource] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (url === '/api/v1/jobs') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `/api/v1/sources/${activeSource.id}/disconnect`) {
        return new Response(
          JSON.stringify({
            ...activeSource,
            status: 'DISCONNECTED',
            disconnectedAt: '2027-01-03T00:00:00.000Z',
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SourceManagementPage />)

    const sourceList = await screen.findByRole('region', {
      name: '등록된 데이터 소스',
    })
    expect(within(sourceList).getAllByRole('article')).toHaveLength(1)
    expect(screen.getByText('현재 연결된 소스 1개')).toBeInTheDocument()
    expect(screen.getByText('0x2390…f2b2')).toBeInTheDocument()
    expect(screen.queryByText('0x9510…b14d')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '연결 해제' }))

    expect(
      await screen.findByRole('heading', {
        name: '아직 연결된 데이터 소스가 없어요',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('현재 연결된 소스 0개')).toBeInTheDocument()
    expect(
      screen.queryByRole('region', { name: '등록된 데이터 소스' }),
    ).not.toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/sources/${activeSource.id}/disconnect`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('uses production-safe copy when source services are unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify({ error: { code: 'WALLET_SOURCE_UNAVAILABLE' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
    )))

    render(<SourceManagementPage />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveClass(
      'source-state-card',
      'source-state-card--error',
    )
    expect(
      within(alert).getByRole('heading', {
        name: '데이터 소스를 불러오지 못했습니다',
      }),
    ).toBeInTheDocument()
    expect(alert).toHaveTextContent('잠시 후 다시 시도해 주세요')
    expect(
      screen.getByText('현재 연결된 소스 수를 확인할 수 없습니다'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('현재 연결된 소스 0개'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/로컬 데이터베이스/)).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: '아직 연결된 데이터 소스가 없어요' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        '각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.',
      ),
    ).not.toBeInTheDocument()
  })

  it.each([
    ['PENDING', '장부 반영 중'],
    ['REVIEW_REQUIRED', '장부 반영 보류'],
    ['NO_POSTING', '장부 항목 없음'],
    ['UNAVAILABLE', '장부 상태 확인 필요'],
  ] as const)(
    'does not claim ledger completion for %s EVM materialization',
    async (ledgerMaterializationState, expectedCopy) => {
      const source = {
        id: '33333333-3333-4333-8333-333333333333',
        type: 'EVM_WALLET',
        address: '0x239000000000000000000000000000000000f2b2',
        accountType: 'EOA',
        verificationChainId: 'eip155:1',
        verifiedAt: '2027-01-01T00:00:00.000Z',
        status: 'ACTIVE',
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
        chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
      }
      const job = {
        id: 'job-1',
        sourceId: source.id,
        sourceKind: 'EVM_WALLET',
        state: 'SUCCEEDED',
        phase: 'COMPLETE',
        attempts: 1,
        processedRecords: 8,
        ledgerMaterializationState,
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:01:00.000Z',
      }
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/sources') {
          return new Response(JSON.stringify({ items: [source] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url === '/api/v1/jobs') {
          return new Response(JSON.stringify({ items: [job] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }))

      render(<SourceManagementPage />)

      expect(await screen.findByText(expectedCopy)).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: /장부 반영 완료/ })).not.toBeInTheDocument()
    },
  )

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
          job: {
            ...queuedJob,
            state: 'SUCCEEDED',
            phase: 'COMPLETE',
            ledgerMaterializationState: 'POSTED',
            ledgerPostingCount: 3,
          },
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
      name: '처리 확인 필요',
    })
    expect(screen.queryByText('JIT_START_FAILED')).not.toBeInTheDocument()
    expect(
      screen.queryByTitle('JIT 실행 요청에 실패했습니다.'),
    ).not.toBeInTheDocument()
    fireEvent.click(statusButton)

    expect(
      screen.getByRole('heading', {
        name: '거래 수집이 처리 도중 멈췄습니다',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '수집 처리에서 문제가 확인되었습니다. 같은 조건으로 다시 시도하면 같은 지점에서 멈출 수 있습니다.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('수집 처리 확인 필요')).toBeInTheDocument()
    expect(
      screen.queryByText('JIT 실행 요청에 실패했습니다.'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('JIT_START_FAILED')).not.toBeInTheDocument()
    expect(screen.getByText('2027-01-01 – 2027-12-31')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 수집' }))

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: /장부 반영 완료.*3개 항목/ }),
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

  it('reports the polled attempt count instead of the freshly created one', async () => {
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
      phase: 'PUBLISH',
      attempts: 3,
      processedRecords: 0,
      failureCode: 'JIT_RUN_FAILED',
      failureMessage: 'JIT 실행이 실패했습니다.',
      requestedCoverageStart: '2027-01-01',
      requestedCoverageEnd: '2027-12-31',
      trigger: 'USER_REQUEST',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:05:00.000Z',
    }
    // A newly created retry job always starts at zero attempts. The worker
    // counts the attempt when it claims the job, so the panel must show what
    // the poll reports rather than what the creation response carried.
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
    const polledJob = {
      ...queuedJob,
      state: 'FAILED',
      phase: 'PUBLISH',
      attempts: 4,
      failureCode: 'JIT_RUN_FAILED',
      failureMessage: 'JIT 실행이 실패했습니다.',
      updatedAt: '2027-01-01T00:09:00.000Z',
    }
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown, status: number) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url === '/api/v1/sources') return json({ items: [source] }, 200)
      if (url === '/api/v1/jobs') return json({ items: [failedJob] }, 200)
      if (url === `/api/v1/jobs/${failedJob.id}/retry`) {
        return json({ job: queuedJob }, 201)
      }
      if (url === `/api/v1/jobs/${queuedJob.id}`) {
        return json({ job: polledJob }, 200)
      }
      throw new Error(`Unexpected request: ${url}`)
    }))

    render(<SourceManagementPage />)

    fireEvent.click(
      await screen.findByRole('button', { name: '처리 확인 필요' }),
    )
    expect(screen.getByText('3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '다시 수집' }))

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '처리 확인 필요' }),
      ).toBeInTheDocument()
    })
    fireEvent.click(screen.getByRole('button', { name: '처리 확인 필요' }))

    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('uses a safe fallback for unknown failures and shares the same right-control structure', async () => {
    const pdfSource = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'UPBIT_PDF',
      provider: 'UPBIT',
      originalFilename: 'upbit-history.pdf',
      mediaType: 'application/pdf',
      byteLength: 1024,
      artifactDigest: 'a'.repeat(64),
      coverageStart: '2027-01-01',
      coverageEnd: '2027-12-31',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
    }
    const walletSource = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'EVM_WALLET',
      address: '0x239000000000000000000000000000000000f2b2',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-01-01T00:00:00.000Z',
      label: '세무 지갑',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    const failedJob = {
      id: '77777777-7777-4777-8777-777777777777',
      sourceId: pdfSource.id,
      sourceKind: 'UPBIT_PDF',
      state: 'FAILED',
      phase: 'EXTRACT',
      attempts: 1,
      processedRecords: 0,
      failureCode: 'INTERNAL_STORAGE_FAILURE',
      failureMessage: 'Backend detail must stay private.',
      requestedCoverageStart: '2027-01-01',
      requestedCoverageEnd: '2027-12-31',
      trigger: 'USER_REQUEST',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:05:00.000Z',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/v1/sources') {
          return new Response(
            JSON.stringify({ items: [pdfSource, walletSource] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          )
        }
        if (url === '/api/v1/jobs') {
          return new Response(JSON.stringify({ items: [failedJob] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    )

    render(<SourceManagementPage />)

    const sourceList = await screen.findByRole('region', {
      name: '등록된 데이터 소스',
    })
    const sourceItems = within(sourceList).getAllByRole('article')
    expect(sourceItems).toHaveLength(2)
    const pdfSourceItem = sourceItems[0]
    if (!pdfSourceItem) {
      throw new Error('Expected the PDF source row to be rendered.')
    }
    for (const item of sourceItems) {
      expect(item.children).toHaveLength(2)
      expect(item.children[1]).toHaveClass('source-list__right-controls')
    }
    expect(screen.getByText('현재 연결된 소스 2개')).toBeInTheDocument()

    fireEvent.click(
      within(pdfSourceItem).getByRole('button', {
        name: '처리 확인 필요',
      }),
    )

    expect(
      screen.getByRole('heading', {
        name: '수집 작업을 완료하지 못했습니다',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('수집 처리 문제')).toBeInTheDocument()
    expect(
      screen.getByText(
        '일시적인 문제가 발생했습니다. 잠시 후 다시 수집해 주세요.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('INTERNAL_STORAGE_FAILURE'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Backend detail must stay private.'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTitle('Backend detail must stay private.'),
    ).not.toBeInTheDocument()
  })

  it('keeps Optimism available while starting collection for an updated Ethereum period', async () => {
    const source = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'EVM_WALLET',
      address: '0x239000000000000000000000000000000000f2b2',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-01-01T00:00:00.000Z',
      label: '세무 지갑',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    const existingJob = {
      id: '55555555-5555-4555-8555-555555555555',
      sourceId: source.id,
      sourceKind: 'EVM_WALLET',
      state: 'SUCCEEDED',
      phase: 'COMPLETE',
      attempts: 1,
      processedRecords: 4,
      requestedCoverageStart: '2026-07-28',
      requestedCoverageEnd: '2026-07-28',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:05:00.000Z',
    }
    const newJob = {
      ...existingJob,
      id: '66666666-6666-4666-8666-666666666666',
      state: 'QUEUED',
      phase: 'QUEUED',
      attempts: 0,
      processedRecords: 0,
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
        return new Response(JSON.stringify({ items: [existingJob] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/v1/syncs') {
        return new Response(JSON.stringify({ job: newJob }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === `/api/v1/jobs/${newJob.id}`) {
        return new Response(JSON.stringify({
          job: { ...newJob, state: 'SUCCEEDED', phase: 'COMPLETE' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SourceManagementPage />)

    fireEvent.click(await screen.findByRole('button', { name: '수집 네트워크 관리' }))
    expect(screen.getByRole('checkbox', { name: 'Ethereum' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Optimism/ })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Optimism/ })).toBeEnabled()
    fireEvent.change(screen.getByLabelText('수집 시작일'), {
      target: { value: '2025-01-01' },
    })
    fireEvent.change(screen.getByLabelText('수집 종료일'), {
      target: { value: '2026-08-11' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '설정 저장 후 수집' }),
    )

    expect(await screen.findByRole('status')).toHaveTextContent(
      '수집 설정을 저장하고 선택한 기간의 새 수집을 시작했습니다.',
    )
    expect(screen.getByText('Ethereum')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/syncs',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"coverageStart":"2025-01-01"'),
      }),
    )
  })

  it('does not save or start collection when the wallet network selection is unchanged', async () => {
    const source = {
      id: '77777777-7777-4777-8777-777777777777',
      type: 'EVM_WALLET',
      address: '0x239000000000000000000000000000000000f2b2',
      accountType: 'EOA',
      verificationChainId: 'eip155:1',
      verifiedAt: '2027-01-01T00:00:00.000Z',
      label: '세무 지갑',
      status: 'ACTIVE',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
      chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
    }
    const existingJob = {
      id: '88888888-8888-4888-8888-888888888888',
      sourceId: source.id,
      sourceKind: 'EVM_WALLET',
      state: 'SUCCEEDED',
      phase: 'COMPLETE',
      attempts: 1,
      processedRecords: 4,
      requestedCoverageStart: '2026-07-28',
      requestedCoverageEnd: '2026-07-28',
      createdAt: '2027-01-01T00:00:00.000Z',
      updatedAt: '2027-01-01T00:05:00.000Z',
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
        return new Response(JSON.stringify({ items: [existingJob] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<SourceManagementPage />)

    fireEvent.click(
      await screen.findByRole('button', { name: '수집 네트워크 관리' }),
    )
    expect(screen.getByRole('checkbox', { name: 'Ethereum' })).toBeChecked()
    expect(screen.getByText('현재 저장된 설정과 같습니다.')).toBeInTheDocument()

    const saveButton = screen.getByRole('button', { name: '변경사항 없음' })
    expect(saveButton).toBeDisabled()
    fireEvent.click(saveButton)

    expect(
      fetchMock.mock.calls.some(
        ([input]) =>
          String(input) === `/api/v1/sources/${source.id}/chains`,
      ),
    ).toBe(false)
    expect(
      fetchMock.mock.calls.some(
        ([input]) => String(input) === '/api/v1/syncs',
      ),
    ).toBe(false)
  })

  it.each(['RUNNING', 'QUEUED'] as const)(
    'blocks wallet network changes while the latest collection is %s',
    async (state) => {
      const source = {
        id: '99999999-9999-4999-8999-999999999999',
        type: 'EVM_WALLET',
        address: '0x239000000000000000000000000000000000f2b2',
        accountType: 'EOA',
        verificationChainId: 'eip155:1',
        verifiedAt: '2027-01-01T00:00:00.000Z',
        label: '세무 지갑',
        status: 'ACTIVE',
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:00:00.000Z',
        chainScopes: [{ chainId: 'eip155:1', status: 'ACTIVE' }],
      }
      const activeJob = {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        sourceId: source.id,
        sourceKind: 'EVM_WALLET',
        state,
        phase: state,
        attempts: 1,
        processedRecords: 2,
        requestedCoverageStart: '2026-07-28',
        requestedCoverageEnd: '2026-07-28',
        createdAt: '2027-01-01T00:00:00.000Z',
        updatedAt: '2027-01-01T00:05:00.000Z',
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
          return new Response(JSON.stringify({ items: [activeJob] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        if (url === `/api/v1/jobs/${activeJob.id}`) {
          return new Response(JSON.stringify({ job: activeJob }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      })
      vi.stubGlobal('fetch', fetchMock)

      const { unmount } = render(<SourceManagementPage />)

      fireEvent.click(
        await screen.findByRole('button', { name: '수집 네트워크 관리' }),
      )
      const editor = screen.getByRole('region', {
        name: '수집 네트워크 관리',
      })
      const ethereum = within(editor).getByRole('checkbox', {
        name: 'Ethereum',
      })
      const optimism = within(editor).getByRole('checkbox', {
        name: /Optimism/,
      })

      expect(ethereum).toBeChecked()
      expect(ethereum).toBeDisabled()
      expect(optimism).not.toBeChecked()
      expect(optimism).toBeDisabled()
      expect(within(editor).getByRole('status')).toHaveTextContent(
        '현재 수집이 진행 중입니다. 완료된 뒤 네트워크 설정을 변경할 수 있습니다.',
      )

      const saveButton = within(editor).getByRole('button', {
        name: '수집 진행 중',
      })
      expect(saveButton).toBeDisabled()
      fireEvent.click(saveButton)

      expect(optimism).not.toBeChecked()
      expect(
        fetchMock.mock.calls.some(
          ([input]) =>
            String(input) === `/api/v1/sources/${source.id}/chains`,
        ),
      ).toBe(false)
      expect(
        fetchMock.mock.calls.some(
          ([input]) => String(input) === '/api/v1/syncs',
        ),
      ).toBe(false)

      unmount()
    },
  )

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
    expect(screen.queryByText('지원 방식')).not.toBeInTheDocument()
    expect(
      screen.queryByText(
        '두 방식 모두 수집 범위를 확인한 뒤 최초 수집 작업을 시작합니다.',
      ),
    ).not.toBeInTheDocument()
    expect(
      within(methods).getByText('준비 중'),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      within(methods).queryByRole('link', { name: 'Upbit PDF 선택' }),
    ).not.toBeInTheDocument()
    expect(
      within(methods).getByRole('button', { name: 'EVM Wallet 선택' }),
    ).toBeEnabled()
    expect(
      within(methods).getByText('암호화되지 않은 PDF 지원'),
    ).toBeInTheDocument()
    expect(
      within(methods).getByText('새 거래는 최신 PDF를 다시 등록'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'Upbit는 거래내역서 등록, EVM은 브라우저 지갑의 읽기 전용 연결 방식으로 등록합니다.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('PDF 업로드')).not.toBeInTheDocument()
  })

  it('opens wallet selection without leaving source selection', async () => {
    window.history.pushState({}, '', '/sources/new')
    render(<SourceTypeSelectionPage />)

    expect(
      screen.queryByRole('dialog', { name: '지갑 연결' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: 'EVM Wallet 선택' }),
    )

    expect(
      await screen.findByRole('dialog', { name: '지갑 연결' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '데이터 소스 추가' }),
    ).toBeInTheDocument()
    expect(window.location.pathname).toBe('/sources/new')

    fireEvent.keyDown(window, { key: 'Escape' })

    expect(
      screen.queryByRole('dialog', { name: '지갑 연결' }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: '데이터 소스 추가' }),
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
      screen.getByText('준비 중'),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.queryByRole('link', { name: 'PDF 등록 시작' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      '현재는 안전한 Upbit 문서 처리 경로를 준비하고 있습니다.',
    )
    expect(
      screen.getByRole('link', { name: '연결 방식 다시 선택' }),
    ).toHaveAttribute('href', '/sources/new')
    expect(screen.queryByText('PDF 업로드')).not.toBeInTheDocument()
  })

  it('uses readable dark text for the enabled Upbit PDF registration action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            upbitPdf: {
              registrationEnabled: true,
              encryptedPdfSupported: true,
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    )

    render(<SourceMethodIntroPage methodId="upbit-pdf" />)

    expect(
      await screen.findByRole('link', { name: 'PDF 등록 시작' }),
    ).toHaveClass('source-primary-action--dark-text')
  })

})
