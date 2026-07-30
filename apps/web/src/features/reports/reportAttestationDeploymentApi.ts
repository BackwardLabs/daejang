import { requestApi } from '../../api/client.ts'

const network = 'eip155:91342' as const
const mode = 'READ_ONLY' as const
const explorerOrigin = 'https://sepolia-explorer.giwa.io'

const reasonCodes = [
  'RPC_UNAVAILABLE',
  'CHAIN_ID_MISMATCH',
  'EAS_CODE_MISSING',
  'SCHEMA_REGISTRY_CODE_MISSING',
  'REPORT_REGISTRY_CODE_MISSING',
  'REPORT_CONSUMER_CODE_MISSING',
  'EAS_SCHEMA_REGISTRY_MISMATCH',
  'REGISTRY_EAS_MISMATCH',
  'REGISTRY_SCHEMA_UID_MISMATCH',
  'REGISTRY_EVIDENCE_SCHEMA_DIGEST_MISMATCH',
  'CONSUMER_REGISTRY_MISMATCH',
] as const

export type ReportAttestationDeploymentReasonCode =
  (typeof reasonCodes)[number]

export type ReportAttestationDeployment =
  | Readonly<{
      enabled: false
      network: typeof network
      mode: typeof mode
      status: 'NOT_CONFIGURED'
    }>
  | Readonly<{
      enabled: true
      network: typeof network
      mode: typeof mode
      status: 'CONNECTED' | 'UNAVAILABLE' | 'MISCONFIGURED'
      reasonCode: ReportAttestationDeploymentReasonCode | null
      addresses: Readonly<{
        eas: string
        schemaRegistry: string
        reportRegistryProxy: string
        reportConsumer: string
      }>
      schemaUID: string
      evidenceSchemaDigest: string
    }>

const disabledKeys = ['enabled', 'network', 'mode', 'status'] as const
const enabledKeys = [
  'enabled',
  'network',
  'mode',
  'status',
  'reasonCode',
  'addresses',
  'schemaUID',
  'evidenceSchemaDigest',
] as const
const addressKeys = [
  'eas',
  'schemaRegistry',
  'reportRegistryProxy',
  'reportConsumer',
] as const
const reasonCodeSet = new Set<string>(reasonCodes)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isExactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  isRecord(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key))

const isNonzeroAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{40}$/.test(value) &&
  !/^0x0{40}$/i.test(value)

const isNonzeroBytes32 = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^0x[0-9a-fA-F]{64}$/.test(value) &&
  !/^0x0{64}$/i.test(value)

const invalidResponse = (): never => {
  throw new Error('REPORT_ATTESTATION_DEPLOYMENT_RESPONSE_INVALID')
}

export const parseReportAttestationDeployment = (
  value: unknown,
): ReportAttestationDeployment => {
  if (!isRecord(value)) return invalidResponse()
  if (value.enabled === false) {
    if (
      !isExactRecord(value, disabledKeys) ||
      value.network !== network ||
      value.mode !== mode ||
      value.status !== 'NOT_CONFIGURED'
    ) {
      return invalidResponse()
    }
    return {
      enabled: false,
      network,
      mode,
      status: 'NOT_CONFIGURED',
    }
  }

  const addresses = value.addresses
  if (
    value.enabled !== true ||
    !isExactRecord(value, enabledKeys) ||
    value.network !== network ||
    value.mode !== mode ||
    !['CONNECTED', 'UNAVAILABLE', 'MISCONFIGURED'].includes(
      String(value.status),
    ) ||
    !isExactRecord(addresses, addressKeys) ||
    !addressKeys.every((key) => isNonzeroAddress(addresses[key])) ||
    !isNonzeroBytes32(value.schemaUID) ||
    !isNonzeroBytes32(value.evidenceSchemaDigest)
  ) {
    return invalidResponse()
  }

  const status = value.status as
    | 'CONNECTED'
    | 'UNAVAILABLE'
    | 'MISCONFIGURED'
  const reasonCode =
    typeof value.reasonCode === 'string' &&
    reasonCodeSet.has(value.reasonCode)
      ? value.reasonCode as ReportAttestationDeploymentReasonCode
      : value.reasonCode === null
        ? null
        : invalidResponse()
  if (
    (status === 'CONNECTED' && reasonCode !== null) ||
    (status === 'UNAVAILABLE' && reasonCode !== 'RPC_UNAVAILABLE') ||
    (status === 'MISCONFIGURED' &&
      (reasonCode === null || reasonCode === 'RPC_UNAVAILABLE'))
  ) {
    return invalidResponse()
  }

  return {
    enabled: true,
    network,
    mode,
    status,
    reasonCode,
    addresses: {
      eas: addresses.eas as string,
      schemaRegistry: addresses.schemaRegistry as string,
      reportRegistryProxy: addresses.reportRegistryProxy as string,
      reportConsumer: addresses.reportConsumer as string,
    },
    schemaUID: value.schemaUID,
    evidenceSchemaDigest: value.evidenceSchemaDigest,
  }
}

export const loadReportAttestationDeployment = async (
  signal?: AbortSignal,
) =>
  parseReportAttestationDeployment(
    await requestApi<unknown>('/report-attestations/deployment', { signal }),
  )

export const giwaExplorerAddressUrl = (address: string) =>
  `${explorerOrigin}/address/${encodeURIComponent(address)}`
