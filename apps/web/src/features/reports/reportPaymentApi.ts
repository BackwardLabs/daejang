import { BrowserProvider, type Eip1193Provider } from 'ethers'

import { requestRawResponse } from '../../api/client.ts'

const GIWA_CHAIN_ID = 91_342
const GIWA_CHAIN_ID_HEX = '0x164ce'
const GIWA_NETWORK = 'eip155:91342'
const GIWA_RPC_URL = 'https://sepolia-rpc.giwa.io'
const GIWA_EXPLORER_URL = 'https://sepolia-explorer.giwa.io'
const MOCK_USD_TOKEN = '0x1ce6222bd60923a9d5209a7e191016294dc2c961'
const MOCK_USD_NAME = 'Mock USD'
const MOCK_USD_VERSION = '1'
const PAY_TO = '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0'
const PAYMENT_AMOUNT_ATOMIC = '100000'
const PAYMENT_TIMEOUT_SECONDS = 300

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

type ActualTaxReport = {
  schemaVersion: 'giwa.web.tax-report.v1'
  reportId: string
  residentId: string
  taxYear: number
  finality: 'FINAL'
  status: 'FINAL'
  filingStatus: 'READY'
  pointerVersion: number
  reportArtifactDigest: string
  [key: string]: unknown
}

type Requirement = {
  scheme: 'exact'
  network: typeof GIWA_NETWORK
  asset: string
  amount: typeof PAYMENT_AMOUNT_ATOMIC
  payTo: string
  maxTimeoutSeconds: typeof PAYMENT_TIMEOUT_SECONDS
  extra: {
    name: typeof MOCK_USD_NAME
    version: typeof MOCK_USD_VERSION
    paymentOrderId: string
    reportId: string
    residentId: string
    taxYear: number
    finality: 'FINAL'
    pointerVersion: number
    reportArtifactDigest: string
    format: 'json'
    resourceDigest: string
  }
}

type Quote = {
  resourceUrl: string
  requirement: Requirement
}

export type PaidReportResult = {
  report: ActualTaxReport
  explorerUrl?: string
  reusedEntitlement: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const sameAddress = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase()

const encodeBase64Json = (value: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  return window.btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
}

const decodeBase64Json = (value: string): unknown => {
  const binary = window.atob(value)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

const isActualReport = (value: unknown): value is ActualTaxReport =>
  isRecord(value) &&
  value.schemaVersion === 'giwa.web.tax-report.v1' &&
  typeof value.reportId === 'string' &&
  typeof value.residentId === 'string' &&
  typeof value.taxYear === 'number' &&
  value.finality === 'FINAL' &&
  value.status === 'FINAL' &&
  value.filingStatus === 'READY' &&
  typeof value.pointerVersion === 'number' &&
  typeof value.reportArtifactDigest === 'string'

const readReport = async (response: Response) => {
  const value = (await response.json()) as unknown
  if (!isRecord(value) || !isActualReport(value.report)) {
    throw new Error('서버가 반환한 FINAL 보고서를 확인하지 못했습니다.')
  }
  return value.report
}

const isRequirement = (value: unknown, expectedReportId: string, taxYear: number): value is Requirement => {
  if (!isRecord(value) || !isRecord(value.extra)) return false
  return (
    value.scheme === 'exact' &&
    value.network === GIWA_NETWORK &&
    typeof value.asset === 'string' && sameAddress(value.asset, MOCK_USD_TOKEN) &&
    value.amount === PAYMENT_AMOUNT_ATOMIC &&
    typeof value.payTo === 'string' && sameAddress(value.payTo, PAY_TO) &&
    value.maxTimeoutSeconds === PAYMENT_TIMEOUT_SECONDS &&
    value.extra.name === MOCK_USD_NAME && value.extra.version === MOCK_USD_VERSION &&
    value.extra.reportId === expectedReportId && value.extra.taxYear === taxYear &&
    value.extra.finality === 'FINAL' && value.extra.format === 'json' &&
    typeof value.extra.paymentOrderId === 'string' &&
    typeof value.extra.residentId === 'string' &&
    typeof value.extra.pointerVersion === 'number' &&
    typeof value.extra.reportArtifactDigest === 'string' &&
    typeof value.extra.resourceDigest === 'string'
  )
}

const parseQuote = (header: string, endpoint: string, expectedReportId: string, taxYear: number): Quote => {
  const value = decodeBase64Json(header)
  if (!isRecord(value) || value.x402Version !== 2 || !Array.isArray(value.accepts) || !isRecord(value.resource) || typeof value.resource.url !== 'string') {
    throw new Error('지원하지 않는 x402 결제 요구사항입니다.')
  }
  const requirement = value.accepts.find((candidate) => isRequirement(candidate, expectedReportId, taxYear))
  if (!requirement) throw new Error('현재 보고서와 결제 조건이 일치하지 않습니다.')
  const actual = new URL(value.resource.url)
  const expected = new URL(endpoint, window.location.origin)
  if (actual.pathname !== `/api/v1${expected.pathname}` || actual.search !== expected.search) {
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
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: GIWA_CHAIN_ID_HEX }] })
  } catch (error) {
    if (!isRecord(error) || error.code !== 4902) throw error
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: GIWA_CHAIN_ID_HEX,
        chainName: 'GIWA Sepolia',
        nativeCurrency: { name: 'GIWA Sepolia ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: [GIWA_RPC_URL],
        blockExplorerUrls: [GIWA_EXPLORER_URL],
      }],
    })
  }
}

const nonce = () => {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

const isUserRejection = (error: unknown) =>
  isRecord(error) && (error.code === 4001 || error.code === 'ACTION_REJECTED')

const parseSettlement = (header: string, payer: string) => {
  const value = decodeBase64Json(header)
  if (
    !isRecord(value) || value.success !== true || value.network !== GIWA_NETWORK ||
    typeof value.transaction !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.transaction) ||
    typeof value.payer !== 'string' || !sameAddress(value.payer, payer)
  ) {
    throw new Error('정산 증빙을 확인하지 못했습니다.')
  }
  return value.transaction
}

export async function downloadPaidFinalReport(
  taxYear: number,
  expectedReportId: string,
  onPhaseChange?: (phase: 'signing' | 'settling') => void,
): Promise<PaidReportResult> {
  const endpoint = `/tax-reports/${taxYear}/current/download?finality=FINAL&format=json`
  const initial = await requestRawResponse(endpoint, { headers: { accept: 'application/json' } })
  if (initial.ok) {
    return { report: await readReport(initial), reusedEntitlement: true }
  }
  if (initial.status !== 402) throw new Error(`보고서 결제 요청이 HTTP ${initial.status}로 실패했습니다.`)
  const requiredHeader = initial.headers.get('payment-required')
  if (!requiredHeader) throw new Error('PAYMENT-REQUIRED header가 없습니다.')
  const quote = parseQuote(requiredHeader, endpoint, expectedReportId, taxYear)

  const ethereum = getEthereumProvider()
  if (!ethereum) throw new Error('GIWA Sepolia 결제를 지원하는 브라우저 지갑이 필요합니다.')
  try {
    await ethereum.request({ method: 'eth_requestAccounts' })
    await ensureGiwaSepolia(ethereum)
    const provider = new BrowserProvider(ethereum as Eip1193Provider)
    const signer = await provider.getSigner()
    const payer = await signer.getAddress()
    const now = Math.floor(Date.now() / 1000)
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
      { name: MOCK_USD_NAME, version: MOCK_USD_VERSION, chainId: GIWA_CHAIN_ID, verifyingContract: quote.requirement.asset },
      { TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ] },
      { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) },
    )
    onPhaseChange?.('settling')
    const paid = await requestRawResponse(quote.resourceUrl, {
      headers: {
        accept: 'application/json',
        'payment-signature': encodeBase64Json({ x402Version: 2, accepted: quote.requirement, payload: { signature, authorization } }),
      },
    })
    if (!paid.ok) throw new Error(`결제 정산이 HTTP ${paid.status}로 실패했습니다.`)
    const settlementHeader = paid.headers.get('payment-response')
    if (!settlementHeader) throw new Error('PAYMENT-RESPONSE header가 없습니다.')
    const transaction = parseSettlement(settlementHeader, payer)
    const report = await readReport(paid)
    if (report.reportId !== expectedReportId) throw new Error('결제 후 보고서 revision이 변경되었습니다.')
    return { report, explorerUrl: `${GIWA_EXPLORER_URL}/tx/${transaction}`, reusedEntitlement: false }
  } catch (error) {
    if (isUserRejection(error)) throw new Error('사용자가 지갑 서명을 취소했습니다.')
    throw error
  }
}
