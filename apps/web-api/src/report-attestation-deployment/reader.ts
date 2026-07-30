import type { ReportAttestationDeploymentConfig } from '../config.js'

const getSchemaRegistrySelector = '0xf10b5cc8'
const getRegistryEasSelector = '0x8150864d'
const getRegistrySchemaUIDSelector = '0xf3de0506'
const getRegistryEvidenceSchemaDigestSelector = '0x805dd454'
const getConsumerReportRegistrySelector = '0x37941dea'
const hexDataPattern = /^0x(?:[0-9a-fA-F]{2})*$/
const hexQuantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/
const bytes32Pattern = /^0x[0-9a-fA-F]{64}$/
const blockHashPattern = /^0x[0-9a-fA-F]{64}$/

export type ReportAttestationDeploymentSnapshot = Readonly<{
  chainId: bigint
  code: Readonly<{
    eas: string
    schemaRegistry: string
    reportRegistryProxy: string
    reportConsumer: string
  }>
  easSchemaRegistryAddress: string
  registry: Readonly<{
    easAddress: string
    schemaUID: string
    evidenceSchemaDigest: string
  }>
  consumerReportRegistryAddress: string
}>

export interface ReportAttestationDeploymentReader {
  read(): Promise<ReportAttestationDeploymentSnapshot>
}

type ReaderOptions = Readonly<{
  fetchImpl?: typeof fetch
  timeoutMs?: number
  cacheTtlMs?: number
  now?: () => number
}>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export class HttpReportAttestationDeploymentReader
implements ReportAttestationDeploymentReader {
  readonly #config: ReportAttestationDeploymentConfig
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number
  readonly #cacheTtlMs: number
  readonly #now: () => number
  #nextRequestId = 1
  #failureExpiresAt = 0
  #cached:
    | Readonly<{
        expiresAt: number
        value: ReportAttestationDeploymentSnapshot
      }>
    | undefined
  #inFlight: Promise<ReportAttestationDeploymentSnapshot> | undefined

  constructor(
    config: ReportAttestationDeploymentConfig,
    options: ReaderOptions = {},
  ) {
    this.#config = config
    this.#fetch = options.fetchImpl ?? globalThis.fetch
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#cacheTtlMs = options.cacheTtlMs ?? 30_000
    this.#now = options.now ?? Date.now
  }

  async read(): Promise<ReportAttestationDeploymentSnapshot> {
    if (this.#cached && this.#cached.expiresAt > this.#now()) {
      return this.#cached.value
    }
    if (this.#failureExpiresAt > this.#now()) {
      throw new Error('GIWA_REPORT_RPC_UNAVAILABLE')
    }
    if (this.#inFlight) {
      return this.#inFlight
    }

    const inFlight = this.#readUncached()
    this.#inFlight = inFlight
    try {
      const value = await inFlight
      this.#cached = {
        value,
        expiresAt: this.#now() + this.#cacheTtlMs,
      }
      this.#failureExpiresAt = 0
      return value
    } catch (error) {
      this.#failureExpiresAt =
        this.#now() + Math.min(this.#cacheTtlMs, 5_000)
      throw error
    } finally {
      if (this.#inFlight === inFlight) {
        this.#inFlight = undefined
      }
    }
  }

  async #readUncached(): Promise<ReportAttestationDeploymentSnapshot> {
    const anchor = parseBlock(
      await this.#rpc('eth_getBlockByNumber', ['safe', false]),
    )
    const [
      chainId,
      easCode,
      schemaRegistryCode,
      reportRegistryProxyCode,
      reportConsumerCode,
      encodedSchemaRegistry,
      encodedRegistryEas,
      encodedRegistrySchemaUID,
      encodedRegistryEvidenceSchemaDigest,
      encodedConsumerReportRegistry,
    ] = await Promise.all([
      this.#rpc('eth_chainId', []),
      this.#rpc('eth_getCode', [this.#config.easAddress, anchor.number]),
      this.#rpc('eth_getCode', [
        this.#config.schemaRegistryAddress,
        anchor.number,
      ]),
      this.#rpc('eth_getCode', [
        this.#config.reportRegistryProxyAddress,
        anchor.number,
      ]),
      this.#rpc('eth_getCode', [
        this.#config.reportConsumerAddress,
        anchor.number,
      ]),
      this.#rpc('eth_call', [
        {
          to: this.#config.easAddress,
          data: getSchemaRegistrySelector,
        },
        anchor.number,
      ]),
      this.#rpc('eth_call', [
        {
          to: this.#config.reportRegistryProxyAddress,
          data: getRegistryEasSelector,
        },
        anchor.number,
      ]),
      this.#rpc('eth_call', [
        {
          to: this.#config.reportRegistryProxyAddress,
          data: getRegistrySchemaUIDSelector,
        },
        anchor.number,
      ]),
      this.#rpc('eth_call', [
        {
          to: this.#config.reportRegistryProxyAddress,
          data: getRegistryEvidenceSchemaDigestSelector,
        },
        anchor.number,
      ]),
      this.#rpc('eth_call', [
        {
          to: this.#config.reportConsumerAddress,
          data: getConsumerReportRegistrySelector,
        },
        anchor.number,
      ]),
    ])
    const canonicalAnchor = parseBlock(
      await this.#rpc('eth_getBlockByNumber', [anchor.number, false]),
    )
    if (
      canonicalAnchor.number !== anchor.number ||
      canonicalAnchor.hash.toLowerCase() !== anchor.hash.toLowerCase()
    ) {
      throw new Error('GIWA_REPORT_RPC_ANCHOR_CHANGED')
    }

    return Object.freeze({
      chainId: parseChainId(chainId),
      code: Object.freeze({
        eas: parseCode(easCode),
        schemaRegistry: parseCode(schemaRegistryCode),
        reportRegistryProxy: parseCode(reportRegistryProxyCode),
        reportConsumer: parseCode(reportConsumerCode),
      }),
      easSchemaRegistryAddress: parseEncodedAddress(encodedSchemaRegistry),
      registry: Object.freeze({
        easAddress: parseEncodedAddress(encodedRegistryEas),
        schemaUID: parseBytes32(encodedRegistrySchemaUID),
        evidenceSchemaDigest: parseBytes32(
          encodedRegistryEvidenceSchemaDigest,
        ),
      }),
      consumerReportRegistryAddress: parseEncodedAddress(
        encodedConsumerReportRegistry,
      ),
    })
  }

  async #rpc(method: string, params: readonly unknown[]): Promise<unknown> {
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const response = await this.#fetch(this.#config.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error('GIWA_REPORT_RPC_UNAVAILABLE')
      }
      const payload = (await response.json()) as unknown
      if (
        !isRecord(payload) ||
        payload.jsonrpc !== '2.0' ||
        payload.id !== id ||
        Object.hasOwn(payload, 'error') ||
        !Object.hasOwn(payload, 'result')
      ) {
        throw new Error('GIWA_REPORT_RPC_RESPONSE_INVALID')
      }
      return payload.result
    } finally {
      clearTimeout(timeout)
    }
  }
}

const parseChainId = (value: unknown) => {
  if (typeof value !== 'string' || !hexQuantityPattern.test(value)) {
    throw new Error('GIWA_REPORT_RPC_CHAIN_ID_INVALID')
  }
  return BigInt(value)
}

const parseCode = (value: unknown) => {
  if (typeof value !== 'string' || !hexDataPattern.test(value)) {
    throw new Error('GIWA_REPORT_RPC_CODE_INVALID')
  }
  return value
}

const parseEncodedAddress = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !bytes32Pattern.test(value) ||
    value.slice(2, 26) !== '0'.repeat(24)
  ) {
    throw new Error('GIWA_REPORT_RPC_EAS_RESPONSE_INVALID')
  }
  return `0x${value.slice(-40)}`
}

const parseBytes32 = (value: unknown) => {
  if (typeof value !== 'string' || !bytes32Pattern.test(value)) {
    throw new Error('GIWA_REPORT_RPC_BYTES32_RESPONSE_INVALID')
  }
  return value
}

const parseBlock = (value: unknown) => {
  if (
    !isRecord(value) ||
    typeof value.number !== 'string' ||
    !hexQuantityPattern.test(value.number) ||
    typeof value.hash !== 'string' ||
    !blockHashPattern.test(value.hash)
  ) {
    throw new Error('GIWA_REPORT_RPC_BLOCK_INVALID')
  }
  return {
    number: value.number,
    hash: value.hash,
  } as const
}
