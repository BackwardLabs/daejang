import {
  act,
  fireEvent,
  render,
  screen,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EvmWalletConnectionPage,
} from './EvmWalletConnectionPage.tsx'
import {
  completeWalletConnectionMock,
  connectWalletMock,
  requestOwnershipSignatureMock,
  type CompleteWalletConnection,
  type ConnectedWallet,
  type ConnectWallet,
  type RequestOwnershipSignature,
} from './evmWalletFlow.ts'
import type { MetaMaskSessionHandlers } from './metamaskWalletAdapter.ts'

const connectedWallet: ConnectedWallet = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  chainId: 'eip155:1',
  network: 'Ethereum',
  provider: 'metamask',
}

const mockWalletProps = {
  completeConnection: completeWalletConnectionMock,
  connectWallet: connectWalletMock,
  requestSignature: requestOwnershipSignatureMock,
  subscribeToWalletSession: () => () => undefined,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })

  return { promise, resolve }
}

function serializeStorage(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)

    return key ? `${key}:${storage.getItem(key) ?? ''}` : ''
  }).join('|')
}

async function moveToOwnership(
  props: Parameters<typeof EvmWalletConnectionPage>[0] = {},
) {
  render(<EvmWalletConnectionPage {...mockWalletProps} {...props} />)
  fireEvent.click(screen.getByRole('radio', { name: 'MetaMask' }))
  fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

  await screen.findByRole('heading', { name: '지갑 소유권 확인' })
}

async function moveToScope(
  props: Parameters<typeof EvmWalletConnectionPage>[0] = {},
) {
  await moveToOwnership(props)
  fireEvent.click(
    screen.getByRole('button', { name: '지갑에서 서명하기' }),
  )

  await screen.findByRole('heading', { name: '연결 및 수집 범위' })
}

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('EvmWalletConnectionPage', () => {
  it('completes the Figma wallet connection, signature, scope, and backfill flow', async () => {
    render(<EvmWalletConnectionPage {...mockWalletProps} />)

    expect(
      screen.getByRole('heading', { name: 'EVM Wallet 연결' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '지갑 연결' }),
    ).toBeDisabled()
    expect(
      screen.queryByRole('radio', { name: 'Rabby Wallet' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('radio', { name: 'WalletConnect (Reown)' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('radio', { name: 'Coinbase Wallet' }),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: 'MetaMask' }))
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    await screen.findByRole('heading', { name: '지갑 소유권 확인' })
    expect(screen.getByText('0x1234…5678 · Ethereum')).toBeInTheDocument()
    expect(screen.queryByText(connectedWallet.address)).not.toBeInTheDocument()
    expect(screen.getByText('가스비 없음')).toBeInTheDocument()
    expect(screen.getByText(/거래 승인 없음/)).toBeInTheDocument()
    expect(screen.getByText(/자산 이동 권한 없음/)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '지갑에서 서명하기' }),
    )

    await screen.findByRole('heading', { name: '연결 및 수집 범위' })
    expect(screen.getByRole('combobox', { name: '과세연도' })).toHaveValue(
      '2027',
    )
    expect(
      screen.getByText(/매일 자동 \+ 수동 새로고침/),
    ).toBeInTheDocument()
    expect(
      screen.getByText('개발용 지갑 flow preview'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    await screen.findByRole('heading', { name: '지갑 연결이 완료됐어요' })
    expect(screen.getByText('PREVIEW')).toBeInTheDocument()
    expect(
      screen.getByText('Source 저장·backfill 연동 대기'),
    ).toBeInTheDocument()
    expect(screen.queryByText('BACKFILLING')).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '데이터 소스 목록으로' }),
    ).toHaveAttribute('href', '/app/sources')
    expect(window.location.href).not.toContain(connectedWallet.address)
    expect(serializeStorage(window.localStorage)).not.toContain(
      connectedWallet.address,
    )
    expect(serializeStorage(window.sessionStorage)).not.toContain(
      connectedWallet.address,
    )
  })

  it('shows a stable provider error and keeps the selected provider retryable', async () => {
    const connectWallet = vi.fn<ConnectWallet>()
    connectWallet.mockResolvedValue({
      error: {
        code: 'PROVIDER_UNAVAILABLE',
        requestId: 'wallet-request-01',
      },
      ok: false,
    })

    render(
      <EvmWalletConnectionPage
        {...mockWalletProps}
        connectWallet={connectWallet}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'MetaMask' }))
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    expect(
      await screen.findByText('MetaMask를 찾을 수 없어요'),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'MetaMask' })).toBeChecked()
    expect(screen.queryByText('wallet-request-01')).not.toBeInTheDocument()
  })

  it('marks Other Wallets as coming soon and prevents connection', () => {
    const connectWallet = vi.fn<ConnectWallet>()

    render(
      <EvmWalletConnectionPage
        {...mockWalletProps}
        connectWallet={connectWallet}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Other Wallets' }))

    expect(
      screen.getByText('Other Wallets는 추후 지원 예정입니다'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('현재 실제 지갑 연결은 MetaMask만 지원합니다.'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '추후 지원 예정' }),
    ).toBeDisabled()
    expect(connectWallet).not.toHaveBeenCalled()
  })

  it.each([
    {
      emit: (handlers: MetaMaskSessionHandlers) =>
        handlers.onAccountsChanged?.([
          '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        ]),
      heading: '연결된 계정이 변경되었어요',
    },
    {
      emit: (handlers: MetaMaskSessionHandlers) =>
        handlers.onChainChanged?.('0xaa36a7'),
      heading: '연결된 네트워크가 변경되었어요',
    },
    {
      emit: (handlers: MetaMaskSessionHandlers) =>
        handlers.onDisconnect?.({ code: 4900 }),
      heading: 'MetaMask 연결이 끊어졌어요',
    },
  ])(
    'invalidates ownership when a MetaMask session event occurs: $heading',
    async ({ emit, heading }) => {
      let subscribedHandlers: MetaMaskSessionHandlers | null = null
      const unsubscribe = vi.fn()
      const subscribeToWalletSession = vi.fn(
        (handlers: MetaMaskSessionHandlers) => {
          subscribedHandlers = handlers
          return unsubscribe
        },
      )

      await moveToOwnership({ subscribeToWalletSession })
      expect(subscribeToWalletSession).toHaveBeenCalledTimes(1)
      const handlers =
        subscribedHandlers as MetaMaskSessionHandlers | null
      if (!handlers) {
        throw new Error('Expected MetaMask session handlers.')
      }

      act(() => emit(handlers))

      expect(await screen.findByText(heading)).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'MetaMask' })).toBeChecked()
      expect(unsubscribe).toHaveBeenCalledTimes(1)
    },
  )

  it('keeps ownership active for the same account and Ethereum mainnet', async () => {
    let subscribedHandlers: MetaMaskSessionHandlers | null = null
    const unsubscribe = vi.fn()
    const subscribeToWalletSession = vi.fn(
      (handlers: MetaMaskSessionHandlers) => {
        subscribedHandlers = handlers
        return unsubscribe
      },
    )

    await moveToOwnership({ subscribeToWalletSession })
    const handlers =
      subscribedHandlers as MetaMaskSessionHandlers | null
    if (!handlers) {
      throw new Error('Expected MetaMask session handlers.')
    }

    act(() => {
      handlers.onAccountsChanged?.([
        connectedWallet.address.toUpperCase(),
      ])
      handlers.onChainChanged?.('0x1')
    })

    expect(
      screen.getByRole('heading', { name: '지갑 소유권 확인' }),
    ).toBeInTheDocument()
    expect(unsubscribe).not.toHaveBeenCalled()
  })

  it('aborts signing and ignores its late result after the account changes', async () => {
    const pendingSignature =
      deferred<Awaited<ReturnType<RequestOwnershipSignature>>>()
    let requestSignal: AbortSignal | null = null
    const requestSignature: RequestOwnershipSignature = vi.fn(
      ({ signal }) => {
        requestSignal = signal
        return pendingSignature.promise
      },
    )
    let subscribedHandlers: MetaMaskSessionHandlers | null = null
    const subscribeToWalletSession = vi.fn(
      (handlers: MetaMaskSessionHandlers) => {
        subscribedHandlers = handlers
        return () => undefined
      },
    )

    await moveToOwnership({
      requestSignature,
      subscribeToWalletSession,
    })
    fireEvent.click(
      screen.getByRole('button', { name: '지갑에서 서명하기' }),
    )
    await screen.findByRole('heading', { name: '서명 확인 중' })

    const handlers =
      subscribedHandlers as MetaMaskSessionHandlers | null
    if (!handlers) {
      throw new Error('Expected MetaMask session handlers.')
    }
    act(() => {
      handlers.onAccountsChanged?.([
        '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      ])
    })

    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true)
    expect(
      await screen.findByText('연결된 계정이 변경되었어요'),
    ).toBeInTheDocument()

    await act(async () => {
      pendingSignature.resolve({
        ok: true,
        proofMode: 'CLIENT_PREVIEW',
        verificationId: 'late-session-verification',
      })
      await Promise.resolve()
    })

    expect(
      screen.queryByRole('heading', { name: '연결 및 수집 범위' }),
    ).not.toBeInTheDocument()
  })

  it('supports a rejected signature and succeeds when the user retries', async () => {
    const requestSignature = vi
      .fn<RequestOwnershipSignature>()
      .mockResolvedValueOnce({
        error: { code: 'SIGNATURE_REJECTED' },
        ok: false,
      })
      .mockResolvedValueOnce({
        ok: true,
        proofMode: 'CLIENT_PREVIEW',
        verificationId: 'verification-retry',
      })

    await moveToOwnership({ requestSignature })
    fireEvent.click(
      screen.getByRole('button', { name: '지갑에서 서명하기' }),
    )

    expect(
      await screen.findByRole('heading', { name: '서명이 취소되었습니다' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/취소된 요청은 연결 완료로 처리하지 않습니다/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '다시 서명하기' }))

    expect(
      await screen.findByRole('heading', { name: '연결 및 수집 범위' }),
    ).toBeInTheDocument()
    expect(requestSignature).toHaveBeenCalledTimes(2)
  })

  it('renders the waiting state and ignores a late signature after cancellation', async () => {
    const pendingSignature =
      deferred<Awaited<ReturnType<RequestOwnershipSignature>>>()
    const requestSignature: RequestOwnershipSignature = vi.fn(
      () => pendingSignature.promise,
    )

    await moveToOwnership({ requestSignature })
    fireEvent.click(
      screen.getByRole('button', { name: '지갑에서 서명하기' }),
    )

    expect(
      await screen.findByRole('heading', { name: '서명 확인 중' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '지갑 다시 열기' }))
    expect(
      await screen.findByText(/대기 중인 서명 요청을 확인해 주세요/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '취소' }))
    expect(
      await screen.findByRole('heading', { name: '서명이 취소되었습니다' }),
    ).toBeInTheDocument()

    pendingSignature.resolve({
      ok: true,
      proofMode: 'CLIENT_PREVIEW',
      verificationId: 'late-verification',
    })

    expect(
      screen.queryByRole('heading', { name: '연결 및 수집 범위' }),
    ).not.toBeInTheDocument()
  })

  it('validates a custom period and prevents duplicate completion requests', async () => {
    const pendingCompletion =
      deferred<Awaited<ReturnType<CompleteWalletConnection>>>()
    const completeConnection: CompleteWalletConnection = vi.fn(
      () => pendingCompletion.promise,
    )

    await moveToScope({ completeConnection })
    fireEvent.click(
      screen.getByRole('radio', { name: '직접 기간 설정' }),
    )
    fireEvent.change(screen.getByLabelText('시작일'), {
      target: { value: '2026-01-01' },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    expect(
      await screen.findByText('직접 설정 기간은 최대 1년까지 선택할 수 있습니다.'),
    ).toBeInTheDocument()
    expect(completeConnection).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/^종료일/), {
      target: { value: '2026-12-31' },
    })
    const submitButton = screen.getByRole('button', { name: '연결 완료' })
    fireEvent.click(submitButton)
    fireEvent.click(submitButton)

    expect(completeConnection).toHaveBeenCalledTimes(1)
    expect(
      await screen.findByRole('button', { name: '연결 저장 중…' }),
    ).toBeDisabled()

    pendingCompletion.resolve({
      jobId: 'job-custom',
      jobStatus: 'BACKFILLING',
      normalizedPeriod: {
        endDate: '2026-12-31',
        mode: 'CUSTOM',
        startDate: '2026-01-01',
      },
      ok: true,
      sourceId: 'source-custom',
      sourceStatus: 'SOURCE_SAVED',
    })

    expect(
      await screen.findByRole('heading', { name: '지갑 연결이 완료됐어요' }),
    ).toBeInTheDocument()
    expect(screen.getByText('2026-01-01 ~ 2026-12-31')).toBeInTheDocument()
  })

  it('keeps the same idempotency key when backfill start is retried', async () => {
    const completeConnection = vi
      .fn<CompleteWalletConnection>()
      .mockResolvedValueOnce({
        error: { code: 'BACKFILL_FAILED' },
        ok: false,
      })
      .mockResolvedValueOnce({
        jobId: 'job-retry',
        jobStatus: 'BACKFILLING',
        normalizedPeriod: {
          endDate: '2027-12-31',
          mode: 'TAX_YEAR',
          startDate: '2027-01-01',
          taxYear: '2027',
        },
        ok: true,
        sourceId: 'source-retry',
        sourceStatus: 'SOURCE_SAVED',
      })

    await moveToScope({ completeConnection })
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    expect(
      await screen.findByText('최초 수집을 시작하지 못했어요'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    await screen.findByRole('heading', { name: '지갑 연결이 완료됐어요' })
    expect(completeConnection).toHaveBeenCalledTimes(2)
    const firstIntentKey = completeConnection.mock.calls[0]?.[0].intentKey
    const secondIntentKey = completeConnection.mock.calls[1]?.[0].intentKey
    expect(firstIntentKey).toBeTruthy()
    expect(secondIntentKey).toBe(firstIntentKey)
  })
})
