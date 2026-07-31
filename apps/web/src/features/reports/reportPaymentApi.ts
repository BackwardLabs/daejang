import { BrowserProvider, type Eip1193Provider } from 'ethers'

import {
  requestApi,
  requestRawResponse,
} from '../../api/client.ts'
import type { TaxReportModel } from './taxReportApi.ts'

const GIWA_CHAIN_ID = 91_342
const GIWA_CHAIN_ID_HEX = '0x164ce'
const GIWA_NETWORK = 'eip155:91342'
const GIWA_RPC_URL = 'https://sepolia-rpc.giwa.io'
const GIWA_EXPLORER_URL = 'https://sepolia-explorer.giwa.io'
const SETTLEMENT_MAX_ATTEMPTS = 25
const SETTLEMENT_MAX_WAIT_MILLISECONDS = 120_000

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

type Requirement = {
  scheme: 'exact'
  network: typeof GIWA_NETWORK
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: {
    name: string
    version: string
    paymentOrderId: string
    reportId: string
    taxYear: number
    finality: 'FINAL'
    pointerVersion: number
    format: 'json'
    resourceDigest: string
  }
}

type Quote = {
  resourceUrl: string
  requirement: Requirement
}

export type ReportPaymentCapability =
  | { enabled: false }
  | {
      enabled: true
      network: typeof GIWA_NETWORK
      asset: string
      amount: string
      payTo: string
      maxTimeoutSeconds: number
      tokenName: string
      tokenVersion: string
    }

export type PaidReportResult = {
  report: TaxReportModel
  explorerUrl?: string
  reusedEntitlement: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const encodeBase64Json = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return window.btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''),
  )
}

const decodeBase64Json = (value: string): unknown => {
  const binary = window.atob(value)
  const bytes = Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  )
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

const isTaxReport = (value: unknown): value is TaxReportModel =>
  isRecord(value) &&
  typeof value.reportId === 'string' &&
  typeof value.taxYear === 'number' &&
  value.finality === 'FINAL' &&
  value.status === 'FINAL' &&
  value.filingStatus === 'READY' &&
  (typeof value.pointerVersion === 'number' ||
    typeof value.pointerVersion === 'string')

const readReport = async (response: Response) => {
  const value = (await response.json()) as unknown
  if (!isRecord(value) || !isTaxReport(value.report)) {
    throw new Error('서버가 반환한 FINAL 보고서를 확인하지 못했습니다.')
  }
  return value.report
}

const isRequirement = (
  value: unknown,
  expectedReportId: string,
  taxYear: number,
  expectedPointerVersion: number,
  capability: Extract<ReportPaymentCapability, { enabled: true }>,
): value is Requirement => {
  if (!isRecord(value) || !isRecord(value.extra)) return false
  return (
    value.scheme === 'exact' &&
    value.network === capability.network &&
    isAddress(value.asset) &&
    sameAddress(value.asset, capability.asset) &&
    value.amount === capability.amount &&
    isAddress(value.payTo) &&
    sameAddress(value.payTo, capability.payTo) &&
    value.maxTimeoutSeconds === capability.maxTimeoutSeconds &&
    value.extra.name === capability.tokenName &&
    value.extra.version === capability.tokenVersion &&
    value.extra.reportId === expectedReportId &&
    value.extra.taxYear === taxYear &&
    value.extra.finality === 'FINAL' &&
    value.extra.format === 'json' &&
    typeof value.extra.paymentOrderId === 'string' &&
    value.extra.pointerVersion === expectedPointerVersion &&
    typeof value.extra.resourceDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(value.extra.resourceDigest)
  )
}

const parseQuote = (
  header: string,
  endpoint: string,
  expectedReportId: string,
  taxYear: number,
  expectedPointerVersion: number,
  capability: Extract<ReportPaymentCapability, { enabled: true }>,
): Quote => {
  const value = decodeBase64Json(header)
  if (
    !isRecord(value) ||
    value.x402Version !== 2 ||
    !Array.isArray(value.accepts) ||
    !isRecord(value.resource) ||
    typeof value.resource.url !== 'string'
  ) {
    throw new Error('지원하지 않는 x402 결제 요구사항입니다.')
  }
  const requirement = value.accepts.find((candidate) =>
    isRequirement(
      candidate,
      expectedReportId,
      taxYear,
      expectedPointerVersion,
      capability,
    ),
  )
  if (!requirement) {
    throw new Error('현재 보고서와 결제 조건이 일치하지 않습니다.')
  }

  const actual = new URL(value.resource.url)
  const expectedPath = `/api/v1${endpoint}`
  const expected = new URL(expectedPath, window.location.origin)
  if (
    actual.origin !== window.location.origin ||
    actual.pathname !== expected.pathname ||
    actual.search !== expected.search
  ) {
    throw new Error('결제 대상 보고서 URL이 요청과 다릅니다.')
  }
  return { resourceUrl: endpoint, requirement }
}

const getEthereumProvider = (): EthereumProvider | undefined => {
  const provider = window.ethereum
  return isRecord(provider) && typeof provider.request === 'function'
    ? provider as EthereumProvider
    : undefined
}

const ensureGiwaSepolia = async (provider: EthereumProvider) => {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: GIWA_CHAIN_ID_HEX }],
    })
  } catch (error) {
    if (!isRecord(error) || error.code !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: GIWA_CHAIN_ID_HEX,
          chainName: 'GIWA Sepolia',
          nativeCurrency: {
            name: 'GIWA Sepolia ETH',
            symbol: 'ETH',
            decimals: 18,
          },
          rpcUrls: [GIWA_RPC_URL],
          blockExplorerUrls: [GIWA_EXPLORER_URL],
        },
      ],
    })
  }
}

const nonce = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`
}

const isUserRejection = (error: unknown) =>
  isRecord(error) &&
  (error.code === 4001 || error.code === 'ACTION_REJECTED')

const parseSettlement = (
  header: string,
  payer: string,
  network: string,
) => {
  const value = decodeBase64Json(header)
  if (
    !isRecord(value) ||
    value.success !== true ||
    value.network !== network ||
    typeof value.transaction !== 'string' ||
    !/^0x[0-9a-fA-F]{64}$/.test(value.transaction) ||
    typeof value.payer !== 'string' ||
    !sameAddress(value.payer, payer)
  ) {
    throw new Error('정산 증빙을 확인하지 못했습니다.')
  }
  return value.transaction
}

type SettlementRetryOptions = {
  wait?: (milliseconds: number) => Promise<void>
  maxAttempts?: number
  maxWaitMilliseconds?: number
  now?: () => number
}

const waitFor = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))

export async function requestSettlementWithRetry(
  resourceUrl: string,
  paymentSignature: string,
  options: SettlementRetryOptions = {},
) {
  const wait = options.wait ?? waitFor
  const maxAttempts = options.maxAttempts ?? SETTLEMENT_MAX_ATTEMPTS
  const maxWaitMilliseconds =
    options.maxWaitMilliseconds ?? SETTLEMENT_MAX_WAIT_MILLISECONDS
  const now = options.now ?? (() => performance.now())
  const startedAt = now()

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remainingMilliseconds =
      maxWaitMilliseconds - (now() - startedAt)
    if (remainingMilliseconds <= 0) {
      throw new Error('결제 정산 재시도 시간이 만료되었습니다.')
    }
    const response = await requestRawResponse(resourceUrl, {
      headers: {
        accept: 'application/json',
        'payment-signature': paymentSignature,
      },
      signal: AbortSignal.timeout(Math.max(1, Math.ceil(remainingMilliseconds))),
    })
    if (response.status !== 409 || attempt === maxAttempts) {
      return response
    }

    const retryAfter = response.headers.get('retry-after')
    if (!retryAfter || !/^[1-9][0-9]*$/.test(retryAfter)) {
      return response
    }
    const delayMilliseconds = Number(retryAfter) * 1_000
    if (
      !Number.isSafeInteger(delayMilliseconds) ||
      now() - startedAt + delayMilliseconds > maxWaitMilliseconds
    ) {
      return response
    }
    await wait(delayMilliseconds)
  }

  throw new Error('결제 정산 재시도 횟수가 올바르지 않습니다.')
}

export async function loadReportPaymentCapability(
  signal?: AbortSignal,
): Promise<ReportPaymentCapability> {
  const value = await requestApi<unknown>(
    '/report-payments/capabilities',
    { signal },
  )
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    (value.enabled &&
      (value.network !== GIWA_NETWORK ||
        !isAddress(value.asset) ||
        typeof value.amount !== 'string' ||
        !/^[1-9][0-9]*$/.test(value.amount) ||
        !isAddress(value.payTo) ||
        typeof value.maxTimeoutSeconds !== 'number' ||
        !Number.isSafeInteger(value.maxTimeoutSeconds) ||
        value.maxTimeoutSeconds <= 0 ||
        value.maxTimeoutSeconds > 3_600 ||
        typeof value.tokenName !== 'string' ||
        value.tokenName.length === 0 ||
        typeof value.tokenVersion !== 'string' ||
        value.tokenVersion.length === 0))
  ) {
    throw new Error('보고서 결제 지원 상태를 확인하지 못했습니다.')
  }
  return value as ReportPaymentCapability
}

export async function downloadPaidFinalReport(
  taxYear: number,
  expectedReportId: string,
  expectedPointerVersion: number,
  capability: Extract<ReportPaymentCapability, { enabled: true }>,
  onPhaseChange?: (phase: 'signing' | 'settling') => void,
): Promise<PaidReportResult> {
  const endpoint =
    `/tax-reports/${taxYear}/current/download?finality=FINAL&format=json`
  const initial = await requestRawResponse(endpoint, {
    headers: { accept: 'application/json' },
  })
  if (initial.ok) {
    return {
      report: await readReport(initial),
      reusedEntitlement: true,
    }
  }
  if (initial.status !== 402) {
    throw new Error(
      `보고서 결제 요청이 HTTP ${initial.status}로 실패했습니다.`,
    )
  }
  const requiredHeader = initial.headers.get('payment-required')
  if (!requiredHeader) {
    throw new Error('PAYMENT-REQUIRED header가 없습니다.')
  }
  const quote = parseQuote(
    requiredHeader,
    endpoint,
    expectedReportId,
    taxYear,
    expectedPointerVersion,
    capability,
  )

  const ethereum = getEthereumProvider()
  if (!ethereum) {
    throw new Error('GIWA Sepolia 결제를 지원하는 브라우저 지갑이 필요합니다.')
  }
  try {
    await ethereum.request({ method: 'eth_requestAccounts' })
    await ensureGiwaSepolia(ethereum)
    const provider = new BrowserProvider(ethereum as Eip1193Provider)
    const signer = await provider.getSigner()
    const payer = await signer.getAddress()
    const now = Math.floor(Date.now() / 1_000)
    const authorization = {
      from: payer,
      to: quote.requirement.payTo,
      value: quote.requirement.amount,
      validAfter: '0',
      validBefore: `${now + quote.requirement.maxTimeoutSeconds}`,
      nonce: nonce(),
    }
    onPhaseChange?.('signing')
    const signature = await signer.signTypedData(
      {
        name: quote.requirement.extra.name,
        version: quote.requirement.extra.version,
        chainId: GIWA_CHAIN_ID,
        verifyingContract: quote.requirement.asset,
      },
      {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
      },
    )
    onPhaseChange?.('settling')
    const paymentSignature = encodeBase64Json({
      x402Version: 2,
      accepted: quote.requirement,
      payload: { signature, authorization },
    })
    const paid = await requestSettlementWithRetry(
      quote.resourceUrl,
      paymentSignature,
    )
    if (!paid.ok) {
      throw new Error(`결제 정산이 HTTP ${paid.status}로 실패했습니다.`)
    }
    const settlementHeader = paid.headers.get('payment-response')
    if (!settlementHeader) {
      throw new Error('PAYMENT-RESPONSE header가 없습니다.')
    }
    const transaction = parseSettlement(
      settlementHeader,
      payer,
      quote.requirement.network,
    )
    const report = await readReport(paid)
    if (
      report.reportId !== expectedReportId ||
      Number(report.pointerVersion) !== expectedPointerVersion
    ) {
      throw new Error('결제 후 보고서 revision이 변경되었습니다.')
    }
    return {
      report,
      explorerUrl: `${GIWA_EXPLORER_URL}/tx/${transaction}`,
      reusedEntitlement: false,
    }
  } catch (error) {
    if (isUserRejection(error)) {
      throw new Error('사용자가 지갑 서명을 취소했습니다.')
    }
    throw error
  }
}
