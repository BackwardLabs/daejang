import {
  normalizeEvmWalletPeriod,
  validateEvmWalletPeriodDraft,
  type CompleteWalletConnection,
  type ConnectWallet,
  type RequestOwnershipSignature,
} from './evmWalletFlow.ts'

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw new DOMException('The wallet flow was aborted.', 'AbortError')
  }
}

function waitForTestBoundary(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    throwIfAborted(signal)

    function handleAbort() {
      window.clearTimeout(timeoutId)
      reject(new DOMException('The wallet flow was aborted.', 'AbortError'))
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, duration)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

export const connectWalletTestFixture: ConnectWallet = async ({
  provider,
  signal,
}) => {
  await waitForTestBoundary(1, signal)
  throwIfAborted(signal)

  return {
    ok: true,
    wallet: {
      address: '0x1234567890abcdef1234567890abcdef12345678',
      chainId: 'eip155:1',
      network: 'Ethereum',
      provider,
    },
  }
}

export const requestOwnershipSignatureTestFixture: RequestOwnershipSignature =
  async ({ signal }) => {
    await waitForTestBoundary(1, signal)
    throwIfAborted(signal)

    return {
      ok: true,
      verificationId: 'verification-test',
    }
  }

export const completeWalletConnectionTestFixture: CompleteWalletConnection =
  async ({ period, signal }) => {
    await waitForTestBoundary(1, signal)
    throwIfAborted(signal)

    const validationError = validateEvmWalletPeriodDraft(period)
    if (validationError) {
      return { error: validationError, ok: false }
    }

    return {
      jobId: 'job-test',
      jobStatus: 'BACKFILLING',
      normalizedPeriod: normalizeEvmWalletPeriod(period),
      ok: true,
      sourceId: 'source-test',
      sourceStatus: 'SOURCE_SAVED',
    }
  }
