import { BrowserProvider, type Eip1193Provider } from 'ethers'

const GIWA_CHAIN_ID = 91_342
const GIWA_CHAIN_ID_HEX = '0x164ce'
const GIWA_NETWORK = 'eip155:91342'
const GIWA_RPC_URL = 'https://sepolia-rpc.giwa.io'
const GIWA_EXPLORER_URL = 'https://sepolia-explorer.giwa.io'
const PAID_RESOURCE_PATH = '/api/demo/x402/synthetic-report'
const MOCK_USD_TOKEN = '0x1ce6222bd60923a9d5209a7e191016294dc2c961'
const MOCK_USD_NAME = 'Mock USD'
const MOCK_USD_SYMBOL = 'mUSD'
const MOCK_USD_VERSION = '1'
const MOCK_USD_DECIMALS = 6
const PAY_TO = '0x28b021c0834f5ab4b2c1e1be8431d6196d8d6ee0'
const PAYMENT_AMOUNT_ATOMIC = '100000'
const PAYMENT_TIMEOUT_SECONDS = 300

const transactionHashPattern = /^0x[0-9a-fA-F]{64}$/

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

export type SyntheticReport = {
  kind: 'synthetic-report'
  environment: 'giwa-sepolia'
  fixture: true
  productionReport: false
  reportId: 'synthetic-giwa-001'
  revision: 1
  summary: {
    transactions: 3
    income: '1250.00'
    expense: '340.00'
    net: '910.00'
  }
}

export type X402PaymentRequirement = {
  scheme: 'exact'
  network: typeof GIWA_NETWORK
  asset: string
  amount: typeof PAYMENT_AMOUNT_ATOMIC
  payTo: string
  maxTimeoutSeconds: typeof PAYMENT_TIMEOUT_SECONDS
  extra?: {
    name?: string
    version?: string
  }
}

export type X402PaymentQuote = {
  resourceUrl: string
  requirement: X402PaymentRequirement
  required: {
    x402Version: 2
    accepts: X402PaymentRequirement[]
    resource?: { url?: string }
  }
}

export type X402Settlement = {
  success: true
  transaction: string
  network: typeof GIWA_NETWORK
  payer: string
}

export type X402PaymentResult = {
  report: SyntheticReport
  paymentResponse: X402Settlement
  explorerUrl: string
}

export type X402PaymentClient = {
  loadQuote: (signal?: AbortSignal) => Promise<X402PaymentQuote>
  executePayment: (
    quote: X402PaymentQuote,
    signal?: AbortSignal,
    onPhaseChange?: (phase: 'signing' | 'settling') => void,
  ) => Promise<X402PaymentResult>
}

export const x402DemoTerms = {
  amountAtomic: PAYMENT_AMOUNT_ATOMIC,
  amountDisplay: '0.1 mUSD',
  asset: MOCK_USD_TOKEN,
  assetDisplay: `${MOCK_USD_NAME} / ${MOCK_USD_SYMBOL} / ${MOCK_USD_DECIMALS} decimals`,
  explorerUrl: GIWA_EXPLORER_URL,
  maxTimeoutSeconds: PAYMENT_TIMEOUT_SECONDS,
  network: GIWA_NETWORK,
  payTo: PAY_TO,
  tokenName: MOCK_USD_NAME,
  tokenVersion: MOCK_USD_VERSION,
} as const

function getConfiguredBaseUrl() {
  return import.meta.env.VITE_X402_DEMO_API_BASE_URL?.trim().replace(/\/$/, '')
}

function encodeBase64Json(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')

  return window.btoa(binary)
}

function decodeBase64Json(value: string): unknown {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getEthereumProvider(): EthereumProvider | undefined {
  const provider = window.ethereum
  if (!isObject(provider) || typeof provider.request !== 'function') {
    return undefined
  }

  return provider as EthereumProvider
}

function sameAddress(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function isPaymentRequirement(value: unknown): value is X402PaymentRequirement {
  if (!isObject(value)) return false
  const extra = value.extra

  return (
    value.scheme === 'exact' &&
    value.network === GIWA_NETWORK &&
    typeof value.asset === 'string' &&
    sameAddress(value.asset, MOCK_USD_TOKEN) &&
    value.amount === PAYMENT_AMOUNT_ATOMIC &&
    typeof value.payTo === 'string' &&
    sameAddress(value.payTo, PAY_TO) &&
    value.maxTimeoutSeconds === PAYMENT_TIMEOUT_SECONDS &&
    (!isObject(extra) ||
      (extra.name === MOCK_USD_NAME && extra.version === MOCK_USD_VERSION))
  )
}

function parsePaymentRequired(value: unknown): X402PaymentQuote['required'] {
  if (!isObject(value) || value.x402Version !== 2 || !Array.isArray(value.accepts)) {
    throw new Error('지원하지 않는 x402 결제 요구사항입니다.')
  }

  const accepts = value.accepts.filter(isPaymentRequirement)
  if (accepts.length !== 1) {
    throw new Error('GIWA Sepolia mock 결제 조건과 일치하지 않습니다.')
  }

  return {
    x402Version: 2,
    accepts,
    resource: isObject(value.resource)
      ? { url: typeof value.resource.url === 'string' ? value.resource.url : undefined }
      : undefined,
  }
}

function parseSettlement(value: unknown): X402Settlement {
  if (
    !isObject(value) ||
    value.success !== true ||
    value.network !== GIWA_NETWORK ||
    typeof value.transaction !== 'string' ||
    !transactionHashPattern.test(value.transaction) ||
    typeof value.payer !== 'string'
  ) {
    throw new Error('정산 응답 증빙을 확인하지 못했습니다.')
  }

  return {
    success: true,
    transaction: value.transaction,
    network: GIWA_NETWORK,
    payer: value.payer,
  }
}

function isSyntheticReport(value: unknown): value is SyntheticReport {
  if (!isObject(value) || !isObject(value.summary)) return false

  return (
    value.kind === 'synthetic-report' &&
    value.environment === 'giwa-sepolia' &&
    value.fixture === true &&
    value.productionReport === false &&
    value.reportId === 'synthetic-giwa-001' &&
    value.revision === 1 &&
    value.summary.transactions === 3 &&
    value.summary.income === '1250.00' &&
    value.summary.expense === '340.00' &&
    value.summary.net === '910.00'
  )
}

function resolveResourceUrl() {
  const baseUrl = getConfiguredBaseUrl()
  if (!baseUrl) {
    throw new Error('데모 API 연결 필요: VITE_X402_DEMO_API_BASE_URL 설정이 필요합니다.')
  }

  return `${baseUrl}${PAID_RESOURCE_PATH}`
}

function generateNonce() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)

  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function isUserRejection(error: unknown) {
  return (
    isObject(error) &&
    (error.code === 4001 || error.code === 'ACTION_REJECTED')
  )
}

async function ensureGiwaSepolia(provider: EthereumProvider) {
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: GIWA_CHAIN_ID_HEX }],
    })
  } catch (error) {
    if (!isObject(error) || error.code !== 4902) {
      throw error
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: GIWA_CHAIN_ID_HEX,
          chainName: 'GIWA Sepolia',
          nativeCurrency: { name: 'GIWA Sepolia ETH', symbol: 'ETH', decimals: 18 },
          rpcUrls: [GIWA_RPC_URL],
          blockExplorerUrls: [GIWA_EXPLORER_URL],
        },
      ],
    })
  }
}

export async function loadX402PaymentQuote(signal?: AbortSignal) {
  const resourceUrl = resolveResourceUrl()
  const response = await fetch(resourceUrl, {
    headers: { accept: 'application/json' },
    method: 'GET',
    signal,
  })

  if (response.status !== 402) {
    throw new Error('최초 요청이 402 Payment Required를 반환하지 않았습니다.')
  }

  const header = response.headers.get('payment-required')
  if (!header) {
    throw new Error('PAYMENT-REQUIRED header가 없습니다.')
  }

  const required = parsePaymentRequired(decodeBase64Json(header))
  const resourceUrlFromQuote = required.resource?.url
  if (resourceUrlFromQuote) {
    const expected = new URL(resourceUrl)
    const actual = new URL(resourceUrlFromQuote)
    if (expected.origin !== actual.origin || expected.pathname !== actual.pathname) {
      throw new Error('결제 요구사항의 resource URL이 요청 URL과 다릅니다.')
    }
  }

  const requirement = required.accepts[0]
  if (!requirement) {
    throw new Error('GIWA Sepolia mock 결제 조건과 일치하지 않습니다.')
  }

  return {
    resourceUrl,
    required,
    requirement,
  }
}

export async function executeX402Payment(
  quote: X402PaymentQuote,
  signal?: AbortSignal,
  onPhaseChange?: (phase: 'signing' | 'settling') => void,
): Promise<X402PaymentResult> {
  const ethereum = getEthereumProvider()
  if (!ethereum) {
    throw new Error('GIWA Sepolia 서명을 지원하는 브라우저 지갑이 필요합니다.')
  }

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
      nonce: generateNonce(),
    }
    onPhaseChange?.('signing')
    const signature = await signer.signTypedData(
      {
        name: MOCK_USD_NAME,
        version: MOCK_USD_VERSION,
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
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    )
    if (signal?.aborted) {
      throw new DOMException('x402 payment aborted.', 'AbortError')
    }

    const paymentSignature = encodeBase64Json({
      x402Version: 2,
      accepted: quote.requirement,
      payload: { signature, authorization },
    })
    onPhaseChange?.('settling')
    const paidResponse = await fetch(quote.resourceUrl, {
      headers: {
        accept: 'application/json',
        'payment-signature': paymentSignature,
      },
      method: 'GET',
      signal,
    })

    if (!paidResponse.ok) {
      throw new Error(`정산 요청이 HTTP ${paidResponse.status}로 실패했습니다.`)
    }

    const responseHeader = paidResponse.headers.get('payment-response')
    if (!responseHeader) {
      throw new Error('PAYMENT-RESPONSE header가 없습니다.')
    }

    const paymentResponse = parseSettlement(decodeBase64Json(responseHeader))
    const report = (await paidResponse.json()) as unknown
    if (!isSyntheticReport(report)) {
      throw new Error('synthetic report fixture 응답을 확인하지 못했습니다.')
    }

    return {
      report,
      paymentResponse,
      explorerUrl: `${GIWA_EXPLORER_URL}/tx/${paymentResponse.transaction}`,
    }
  } catch (error) {
    if (isUserRejection(error)) {
      throw new Error('사용자가 지갑 서명을 취소했습니다.')
    }
    throw error
  }
}

export const defaultX402PaymentClient: X402PaymentClient = {
  loadQuote: loadX402PaymentQuote,
  executePayment: executeX402Payment,
}
