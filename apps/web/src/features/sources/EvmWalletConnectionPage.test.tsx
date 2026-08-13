import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EvmWalletConnectionPage,
} from './EvmWalletConnectionPage.tsx'
import type {
  CompleteWalletConnection,
  ConnectedWallet,
  ConnectWallet,
  RequestOwnershipSignature,
  WatchWalletSyncJob,
} from './evmWalletFlow.ts'
import {
  completeWalletConnectionTestFixture,
  connectWalletTestFixture,
  requestOwnershipSignatureTestFixture,
} from './evmWalletFlow.test-fixtures.ts'

const connectedWallet: ConnectedWallet = {
  address: '0x1234567890abcdef1234567890abcdef12345678',
  chainId: 'eip155:1',
  network: 'Ethereum',
  provider: 'metamask',
}

type WalletPageProps = Parameters<typeof EvmWalletConnectionPage>[0]

const withTestFixtures = (
  overrides: Partial<WalletPageProps> = {},
): WalletPageProps => ({
  completeConnection: completeWalletConnectionTestFixture,
  connectWallet: connectWalletTestFixture,
  requestSignature: requestOwnershipSignatureTestFixture,
  ...overrides,
})

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
  props: Partial<WalletPageProps> = {},
) {
  render(<EvmWalletConnectionPage {...withTestFixtures(props)} />)
  fireEvent.click(screen.getByRole('radio', { name: 'MetaMask' }))
  fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

  await screen.findByRole('heading', { name: '지갑 소유권 확인' })
}

async function moveToScope(
  props: Partial<WalletPageProps> = {},
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
  it('shows every supported EVM network before connecting a wallet', () => {
    render(<EvmWalletConnectionPage {...withTestFixtures()} />)

    expect(screen.getByText('Ethereum, Optimism')).toBeInTheDocument()
    expect(screen.queryByText('GIWA Sepolia')).not.toBeInTheDocument()
  })

  it('starts the Reown connection immediately when launched from source selection', async () => {
    const connectWallet = vi.fn(connectWalletTestFixture)
    const onInitialConnectionResult = vi.fn()

    render(
      <EvmWalletConnectionPage
        {...withTestFixtures({ connectWallet })}
        autoConnectProvider="other"
        onInitialConnectionResult={onInitialConnectionResult}
      />,
    )

    expect(connectWallet).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'other' }),
    )
    expect(
      await screen.findByRole('heading', { name: '지갑 소유권 확인' }),
    ).toBeInTheDocument()
    expect(onInitialConnectionResult).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true }),
    )
  })

  it('completes the Figma wallet connection, signature, scope, and backfill flow', async () => {
    const completeConnection = vi.fn(completeWalletConnectionTestFixture)
    render(
      <EvmWalletConnectionPage
        {...withTestFixtures({ completeConnection })}
      />,
    )

    expect(
      screen.getByRole('heading', { name: 'EVM Wallet 연결' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '지갑 연결' }),
    ).toBeDisabled()

    fireEvent.click(screen.getByRole('radio', { name: 'MetaMask' }))
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    await screen.findByRole('heading', { name: '지갑 소유권 확인' })
    expect(screen.getByText('0x1234…5678 · Ethereum')).toBeInTheDocument()
    expect(screen.queryByText(connectedWallet.address)).not.toBeInTheDocument()
    expect(screen.getByText(/가스비 없음/)).toBeInTheDocument()
    expect(screen.getByText(/거래 승인 없음/)).toBeInTheDocument()
    expect(screen.getByText(/자산 이동 권한 없음/)).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '지갑에서 서명하기' }),
    )

    await screen.findByRole('heading', { name: '연결 및 수집 범위' })
    expect(screen.getByRole('checkbox', { name: 'Ethereum' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Optimism/ })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: /Optimism/ })).toBeEnabled()
    expect(screen.getByLabelText('시작일')).toHaveValue('2025-01-01')
    expect(screen.getByLabelText('종료일')).toHaveValue('2026-08-11')
    expect(
      screen.getByText(/사용자 요청 시 선택 범위 수집/),
    ).toBeInTheDocument()
    expect(screen.queryByText(/최근 90일/)).not.toBeInTheDocument()
    expect(screen.queryByText(/매일 자동/)).not.toBeInTheDocument()
    expect(screen.getByText('원본 금융 데이터는 공개 체인에 기록하지 않음')).toBeInTheDocument()
    expect(screen.getByText('공개 지갑 주소는 거래 조회에만 사용합니다.')).toBeInTheDocument()
    expect(screen.queryByText('사용자 지갑 주소를 기록하지 않음')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    await screen.findByRole('heading', { name: '지갑 연결이 완료됐어요' })
    expect(completeConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        chainIds: ['eip155:1', 'eip155:10'],
        period: {
          endDate: '2026-08-11',
          mode: 'CUSTOM',
          startDate: '2025-01-01',
        },
      }),
    )
    expect(screen.getByText('BACKFILLING')).toBeInTheDocument()
    expect(screen.getByText('선택 기간 수집 중')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: '수집 진행 상태 보기' }),
    ).toHaveAttribute('href', '/dashboard')
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
        {...withTestFixtures({ connectWallet })}
      />,
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Rabby Wallet' }))
    fireEvent.click(screen.getByRole('button', { name: '지갑 연결' }))

    expect(
      await screen.findByText('선택한 지갑을 사용할 수 없어요'),
    ).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Rabby Wallet' })).toBeChecked()
    expect(screen.queryByText('wallet-request-01')).not.toBeInTheDocument()
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
      target: { value: '2025-01-01' },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    expect(
      await screen.findByText('직접 설정 기간은 최대 2년까지 선택할 수 있습니다.'),
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

  it('uses the returned real job id and renders terminal polling updates', async () => {
    const completeConnection = vi.fn<CompleteWalletConnection>(async ({ period }) => ({
      jobId: 'job-real-1',
      jobStatus: 'BACKFILLING',
      normalizedPeriod: {
        mode: 'TAX_YEAR',
        taxYear: period.mode === 'TAX_YEAR' ? period.taxYear : '2027',
        startDate: '2027-01-01',
        endDate: '2027-12-31',
      },
      ok: true,
      sourceId: 'source-real-1',
      sourceStatus: 'SOURCE_SAVED',
    }))
    const watchSyncJob = vi.fn<WatchWalletSyncJob>(async ({ jobId, onUpdate }) => {
      onUpdate({ id: jobId, state: 'RUNNING', attempts: 1, processedRecords: 5, updatedAt: '2027-01-02T00:00:00Z' })
      const terminal = { id: jobId, state: 'SUCCEEDED' as const, attempts: 1, processedRecords: 12, updatedAt: '2027-01-02T00:00:05Z' }
      onUpdate(terminal)
      return terminal
    })

    await moveToScope({ completeConnection, watchSyncJob })
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    expect(await screen.findByText('SUCCEEDED')).toBeInTheDocument()
    expect(screen.getByText('수집 완료')).toBeInTheDocument()
    expect(screen.getByText('job-real-1')).toBeInTheDocument()
    expect(watchSyncJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-real-1' }))
  })

  it('renders a failed sync message in the alert content column', async () => {
    const failureMessage = '요청 기간에 대한 검증된 JIT 블록 범위가 없습니다.'
    const watchSyncJob = vi.fn<WatchWalletSyncJob>(async ({ jobId, onUpdate }) => {
      const terminal = {
        attempts: 1,
        failureMessage,
        id: jobId,
        processedRecords: 0,
        state: 'FAILED' as const,
        updatedAt: '2027-01-02T00:00:05Z',
      }
      onUpdate(terminal)
      return terminal
    })

    await moveToScope({ watchSyncJob })
    fireEvent.click(screen.getByRole('button', { name: '연결 완료' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(failureMessage)
    expect(alert.querySelector('.wallet-flow-alert__icon')).toBeInTheDocument()
    expect(alert.querySelector('p')).toHaveTextContent(failureMessage)
  })
})
