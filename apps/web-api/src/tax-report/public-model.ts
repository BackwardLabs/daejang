import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

import {
  TAX_REPORT_MODEL_V1_MEDIA_TYPE,
  type TaxReportModelArtifact,
} from './model-reader.js'

const REPORT_SCHEMA_V1 = 'giwa.tax-report-model.v1'
const REPORT_ID_PATTERN = /^tax-report:[0-9a-f]{64}$/
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const SIGNED_INTEGER_PATTERN = /^-?(0|[1-9][0-9]{0,77})$/
const UNSIGNED_INTEGER_PATTERN = /^(0|[1-9][0-9]{0,77})$/
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]{0,77}$/
const RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
// Engine gRPC boundary rejects the same artifact above 16 MiB. Keep the BFF
// validation limit aligned so alternate readers cannot widen that contract.
const MAX_CANONICAL_JSON_BYTES = 16 * 1024 * 1024
const MAX_ROWS_PER_SECTION = 100_000

type CanonicalAmountV1 =
  | { status: 'KNOWN'; amount: string }
  | { status: 'UNKNOWN' }

type CanonicalProducerV1 = {
  name: string
  version: string
  artifactDigest: string
}

type CanonicalDisposalRowV1 = {
  movementId: string
  eventId: string
  revisionId: string
  legId: string
  taxAddressId: string
  taxAssetId: string
  ledgerAssetId: string
  quantity: string
  grossProceeds: CanonicalAmountV1
  ancillaryExpense: CanonicalAmountV1
  basis: CanonicalAmountV1
  gainLoss: CanonicalAmountV1
  valuationId?: string
  costMethod: string
  rounding?: string
}

type CanonicalTransferRowV1 = {
  movementId: string
  eventId: string
  revisionId: string
  fromLegId: string
  toLegId: string
  fromAddressId: string
  toAddressId: string
  taxAssetId: string
  quantity: string
  basis: CanonicalAmountV1
  fromCostMethod: string
  toCostMethod: string
}

type CanonicalExcludedConversionRowV1 = {
  eventId: string
  revisionId: string
  relationId: string
  taxAddressId: string
  taxAssetId: string
  fromLegId: string
  toLegId: string
  fromQuantity: string
  toQuantity: string
}

type CanonicalLimitationRowV1 = {
  code: string
  taxAddressId?: string
  taxAssetId?: string
  movementId?: string
  reason: string
  reviewId?: string
  reviewRevisionId?: string
}

export type CanonicalTaxReportModelV1 = {
  schemaVersion: typeof REPORT_SCHEMA_V1
  reportId: string
  inputDigest: string
  subjectId: string
  residentId: string
  taxYear: number
  finality: 'FINAL' | 'PROVISIONAL'
  status: 'FINAL' | 'PARTIAL'
  filingStatus: 'READY' | 'BLOCKED'
  taxInventoryRunId: string
  taxEstimateId: string
  lotRunId: string
  generationId: string
  schemaDigest: string
  denominationAssetId: string
  evidencePackDigest: string
  counts: {
    disposals: number
    transfers: number
    excludedConversions: number
    limitations: number
  }
  summary: {
    gainLoss: CanonicalAmountV1
    taxableBase: CanonicalAmountV1
    nationalTax: CanonicalAmountV1
    localTax: CanonicalAmountV1
    totalTax: CanonicalAmountV1
  }
  disposals: CanonicalDisposalRowV1[]
  transfers: CanonicalTransferRowV1[]
  excludedConversions: CanonicalExcludedConversionRowV1[]
  limitations: CanonicalLimitationRowV1[]
  policy: CanonicalProducerV1
  engine: CanonicalProducerV1
  issuedAt: string
}

export type PublicAmount =
  | { status: 'KNOWN'; amount: string; hasAmount: true }
  | { status: 'UNKNOWN'; amount: null; hasAmount: false }

export type PublicTaxReportDetail = {
  schemaVersion: typeof REPORT_SCHEMA_V1
  reportId: string
  reportModelDigest: string
  inputDigest: string
  evidencePackDigest: string
  taxYear: number
  finality: CanonicalTaxReportModelV1['finality']
  status: CanonicalTaxReportModelV1['status']
  filingStatus: CanonicalTaxReportModelV1['filingStatus']
  denominationAssetId: string
  counts: CanonicalTaxReportModelV1['counts']
  summary: {
    gainLoss: PublicAmount
    taxableBase: PublicAmount
    nationalTax: PublicAmount
    localTax: PublicAmount
    totalTax: PublicAmount
  }
  totals: {
    grossProceeds: PublicAmount
    acquisitionCost: PublicAmount
    ancillaryExpense: PublicAmount
    gainLoss: PublicAmount
  }
  assetSummaries: Array<{
    taxAssetId: string
    disposalCount: number
    quantity: string
    grossProceeds: PublicAmount
    acquisitionCost: PublicAmount
    ancillaryExpense: PublicAmount
    gainLoss: PublicAmount
  }>
  disposals: Array<{
    movementId: string
    eventId: string
    revisionId: string
    legId: string
    taxAddressId: string
    taxAssetId: string
    ledgerAssetId: string
    quantity: string
    grossProceeds: PublicAmount
    ancillaryExpense: PublicAmount
    basis: PublicAmount
    gainLoss: PublicAmount
    valuationId: string | null
    costMethod: string
    rounding: string | null
  }>
  transfers: Array<{
    movementId: string
    eventId: string
    revisionId: string
    fromLegId: string
    toLegId: string
    fromAddressId: string
    toAddressId: string
    taxAssetId: string
    quantity: string
    basis: PublicAmount
    fromCostMethod: string
    toCostMethod: string
  }>
  excludedConversions: Array<{
    eventId: string
    revisionId: string
    relationId: string
    taxAddressId: string
    taxAssetId: string
    fromLegId: string
    toLegId: string
    fromQuantity: string
    toQuantity: string
  }>
  limitations: Array<{
    code: string
    taxAddressId: string | null
    taxAssetId: string | null
    movementId: string | null
    reason: string
    reviewId: string | null
    reviewRevisionId: string | null
  }>
  methodology: {
    taxInventoryRunId: string
    taxEstimateId: string
    lotRunId: string
    generationId: string
    schemaDigest: string
    policy: CanonicalProducerV1
    engine: CanonicalProducerV1
  }
  issuedAt: string
}

export class InvalidTaxReportModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaxReportModelError'
  }
}

type JsonRecord = Record<string, unknown>

const invalid = (path: string, message: string): never => {
  throw new InvalidTaxReportModelError(`${path}: ${message}`)
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isByteArray = (value: unknown): value is Uint8Array =>
  value instanceof Uint8Array

const exactRecord = (
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  if (!isRecord(value)) {
    return invalid(path, 'must be an object')
  }
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, 'is not allowed')
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      invalid(`${path}.${key}`, 'is required')
    }
  }
  return value
}

const requiredString = (
  record: JsonRecord,
  key: string,
  path: string,
) => {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(`${path}.${key}`, 'must be a non-empty string')
  }
  return value
}

const optionalString = (
  record: JsonRecord,
  key: string,
  path: string,
) => {
  if (!Object.hasOwn(record, key)) return undefined
  return requiredString(record, key, path)
}

const enumString = <T extends string>(
  record: JsonRecord,
  key: string,
  path: string,
  values: readonly T[],
) => {
  const value = requiredString(record, key, path)
  if (!values.includes(value as T)) {
    return invalid(`${path}.${key}`, `must be one of ${values.join(', ')}`)
  }
  return value as T
}

const digestString = (
  record: JsonRecord,
  key: string,
  path: string,
) => {
  const value = requiredString(record, key, path)
  if (!DIGEST_PATTERN.test(value)) {
    return invalid(`${path}.${key}`, 'must be a lowercase SHA-256 digest')
  }
  return value
}

const integer = (
  record: JsonRecord,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
) => {
  const value = record[key]
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid(
      `${path}.${key}`,
      `must be an integer between ${minimum} and ${maximum}`,
    )
  }
  return value
}

const numericString = (
  record: JsonRecord,
  key: string,
  path: string,
  pattern: RegExp,
) => {
  const value = requiredString(record, key, path)
  if (!pattern.test(value)) {
    return invalid(`${path}.${key}`, 'must be a canonical base-10 integer')
  }
  return value
}

const parseAmount = (
  value: unknown,
  path: string,
  allowNegative: boolean,
): CanonicalAmountV1 => {
  const initial = exactRecord(value, path, ['status'], ['amount'])
  const status = enumString(initial, 'status', path, ['KNOWN', 'UNKNOWN'])
  if (status === 'UNKNOWN') {
    if (Object.hasOwn(initial, 'amount')) {
      invalid(`${path}.amount`, 'must be omitted when status is UNKNOWN')
    }
    return { status }
  }
  if (!Object.hasOwn(initial, 'amount')) {
    return invalid(`${path}.amount`, 'is required when status is KNOWN')
  }
  return {
    status,
    amount: numericString(
      initial,
      'amount',
      path,
      allowNegative ? SIGNED_INTEGER_PATTERN : UNSIGNED_INTEGER_PATTERN,
    ),
  }
}

const parseProducer = (
  value: unknown,
  path: string,
): CanonicalProducerV1 => {
  const record = exactRecord(value, path, [
    'name',
    'version',
    'artifactDigest',
  ])
  return {
    name: requiredString(record, 'name', path),
    version: requiredString(record, 'version', path),
    artifactDigest: digestString(record, 'artifactDigest', path),
  }
}

const parseArray = <T>(
  value: unknown,
  path: string,
  parseRow: (row: unknown, path: string) => T,
) => {
  if (!Array.isArray(value)) {
    return invalid(path, 'must be an array')
  }
  if (value.length > MAX_ROWS_PER_SECTION) {
    return invalid(path, `must contain at most ${MAX_ROWS_PER_SECTION} rows`)
  }
  return value.map((row, index) => parseRow(row, `${path}[${index}]`))
}

const parseDisposal = (
  value: unknown,
  path: string,
): CanonicalDisposalRowV1 => {
  const record = exactRecord(
    value,
    path,
    [
      'movementId',
      'eventId',
      'revisionId',
      'legId',
      'taxAddressId',
      'taxAssetId',
      'ledgerAssetId',
      'quantity',
      'grossProceeds',
      'ancillaryExpense',
      'basis',
      'gainLoss',
      'costMethod',
    ],
    ['valuationId', 'rounding'],
  )
  const valuationId = optionalString(record, 'valuationId', path)
  const rounding = optionalString(record, 'rounding', path)
  return {
    movementId: requiredString(record, 'movementId', path),
    eventId: requiredString(record, 'eventId', path),
    revisionId: requiredString(record, 'revisionId', path),
    legId: requiredString(record, 'legId', path),
    taxAddressId: requiredString(record, 'taxAddressId', path),
    taxAssetId: requiredString(record, 'taxAssetId', path),
    ledgerAssetId: requiredString(record, 'ledgerAssetId', path),
    quantity: numericString(
      record,
      'quantity',
      path,
      POSITIVE_INTEGER_PATTERN,
    ),
    grossProceeds: parseAmount(
      record.grossProceeds,
      `${path}.grossProceeds`,
      false,
    ),
    ancillaryExpense: parseAmount(
      record.ancillaryExpense,
      `${path}.ancillaryExpense`,
      false,
    ),
    basis: parseAmount(record.basis, `${path}.basis`, false),
    gainLoss: parseAmount(record.gainLoss, `${path}.gainLoss`, true),
    ...(valuationId === undefined ? {} : { valuationId }),
    costMethod: requiredString(record, 'costMethod', path),
    ...(rounding === undefined ? {} : { rounding }),
  }
}

const parseTransfer = (
  value: unknown,
  path: string,
): CanonicalTransferRowV1 => {
  const record = exactRecord(value, path, [
    'movementId',
    'eventId',
    'revisionId',
    'fromLegId',
    'toLegId',
    'fromAddressId',
    'toAddressId',
    'taxAssetId',
    'quantity',
    'basis',
    'fromCostMethod',
    'toCostMethod',
  ])
  return {
    movementId: requiredString(record, 'movementId', path),
    eventId: requiredString(record, 'eventId', path),
    revisionId: requiredString(record, 'revisionId', path),
    fromLegId: requiredString(record, 'fromLegId', path),
    toLegId: requiredString(record, 'toLegId', path),
    fromAddressId: requiredString(record, 'fromAddressId', path),
    toAddressId: requiredString(record, 'toAddressId', path),
    taxAssetId: requiredString(record, 'taxAssetId', path),
    quantity: numericString(
      record,
      'quantity',
      path,
      POSITIVE_INTEGER_PATTERN,
    ),
    basis: parseAmount(record.basis, `${path}.basis`, false),
    fromCostMethod: requiredString(record, 'fromCostMethod', path),
    toCostMethod: requiredString(record, 'toCostMethod', path),
  }
}

const parseExcludedConversion = (
  value: unknown,
  path: string,
): CanonicalExcludedConversionRowV1 => {
  const record = exactRecord(value, path, [
    'eventId',
    'revisionId',
    'relationId',
    'taxAddressId',
    'taxAssetId',
    'fromLegId',
    'toLegId',
    'fromQuantity',
    'toQuantity',
  ])
  return {
    eventId: requiredString(record, 'eventId', path),
    revisionId: requiredString(record, 'revisionId', path),
    relationId: requiredString(record, 'relationId', path),
    taxAddressId: requiredString(record, 'taxAddressId', path),
    taxAssetId: requiredString(record, 'taxAssetId', path),
    fromLegId: requiredString(record, 'fromLegId', path),
    toLegId: requiredString(record, 'toLegId', path),
    fromQuantity: numericString(
      record,
      'fromQuantity',
      path,
      POSITIVE_INTEGER_PATTERN,
    ),
    toQuantity: numericString(
      record,
      'toQuantity',
      path,
      POSITIVE_INTEGER_PATTERN,
    ),
  }
}

const parseLimitation = (
  value: unknown,
  path: string,
): CanonicalLimitationRowV1 => {
  const record = exactRecord(
    value,
    path,
    ['code', 'reason'],
    [
      'taxAddressId',
      'taxAssetId',
      'movementId',
      'reviewId',
      'reviewRevisionId',
    ],
  )
  const taxAddressId = optionalString(record, 'taxAddressId', path)
  const taxAssetId = optionalString(record, 'taxAssetId', path)
  const movementId = optionalString(record, 'movementId', path)
  const reviewId = optionalString(record, 'reviewId', path)
  const reviewRevisionId = optionalString(
    record,
    'reviewRevisionId',
    path,
  )
  if ((reviewId === undefined) !== (reviewRevisionId === undefined)) {
    invalid(
      path,
      'reviewId and reviewRevisionId must be present or omitted together',
    )
  }
  return {
    code: requiredString(record, 'code', path),
    ...(taxAddressId === undefined ? {} : { taxAddressId }),
    ...(taxAssetId === undefined ? {} : { taxAssetId }),
    ...(movementId === undefined ? {} : { movementId }),
    reason: requiredString(record, 'reason', path),
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(reviewRevisionId === undefined ? {} : { reviewRevisionId }),
  }
}

const parseCanonicalModel = (
  value: unknown,
  expectedReportId: string,
): CanonicalTaxReportModelV1 => {
  const record = exactRecord(value, '$', [
    'schemaVersion',
    'reportId',
    'inputDigest',
    'subjectId',
    'residentId',
    'taxYear',
    'finality',
    'status',
    'filingStatus',
    'taxInventoryRunId',
    'taxEstimateId',
    'lotRunId',
    'generationId',
    'schemaDigest',
    'denominationAssetId',
    'evidencePackDigest',
    'counts',
    'summary',
    'disposals',
    'transfers',
    'excludedConversions',
    'limitations',
    'policy',
    'engine',
    'issuedAt',
  ])
  const schemaVersion = requiredString(record, 'schemaVersion', '$')
  if (schemaVersion !== REPORT_SCHEMA_V1) {
    invalid('$.schemaVersion', `must equal ${REPORT_SCHEMA_V1}`)
  }
  const reportId = requiredString(record, 'reportId', '$')
  if (reportId !== expectedReportId) {
    invalid('$.reportId', 'does not match the requested report')
  }
  const countsRecord = exactRecord(record.counts, '$.counts', [
    'disposals',
    'transfers',
    'excludedConversions',
    'limitations',
  ])
  const counts = {
    disposals: integer(
      countsRecord,
      'disposals',
      '$.counts',
      0,
      MAX_ROWS_PER_SECTION,
    ),
    transfers: integer(
      countsRecord,
      'transfers',
      '$.counts',
      0,
      MAX_ROWS_PER_SECTION,
    ),
    excludedConversions: integer(
      countsRecord,
      'excludedConversions',
      '$.counts',
      0,
      MAX_ROWS_PER_SECTION,
    ),
    limitations: integer(
      countsRecord,
      'limitations',
      '$.counts',
      0,
      MAX_ROWS_PER_SECTION,
    ),
  }
  const summaryRecord = exactRecord(record.summary, '$.summary', [
    'gainLoss',
    'taxableBase',
    'nationalTax',
    'localTax',
    'totalTax',
  ])
  const summary = {
    gainLoss: parseAmount(
      summaryRecord.gainLoss,
      '$.summary.gainLoss',
      true,
    ),
    taxableBase: parseAmount(
      summaryRecord.taxableBase,
      '$.summary.taxableBase',
      false,
    ),
    nationalTax: parseAmount(
      summaryRecord.nationalTax,
      '$.summary.nationalTax',
      false,
    ),
    localTax: parseAmount(
      summaryRecord.localTax,
      '$.summary.localTax',
      false,
    ),
    totalTax: parseAmount(
      summaryRecord.totalTax,
      '$.summary.totalTax',
      false,
    ),
  }
  const disposals = parseArray(
    record.disposals,
    '$.disposals',
    parseDisposal,
  )
  const transfers = parseArray(
    record.transfers,
    '$.transfers',
    parseTransfer,
  )
  const excludedConversions = parseArray(
    record.excludedConversions,
    '$.excludedConversions',
    parseExcludedConversion,
  )
  const limitations = parseArray(
    record.limitations,
    '$.limitations',
    parseLimitation,
  )
  if (
    counts.disposals !== disposals.length ||
    counts.transfers !== transfers.length ||
    counts.excludedConversions !== excludedConversions.length ||
    counts.limitations !== limitations.length
  ) {
    invalid('$.counts', 'does not match the materialized row counts')
  }
  const status = enumString(record, 'status', '$', ['FINAL', 'PARTIAL'])
  const finality = enumString(record, 'finality', '$', [
    'FINAL',
    'PROVISIONAL',
  ])
  const filingStatus = enumString(record, 'filingStatus', '$', [
    'READY',
    'BLOCKED',
  ])
  if (
    status === 'FINAL' &&
    (finality !== 'FINAL' ||
      filingStatus !== 'READY' ||
      counts.limitations !== 0)
  ) {
    invalid(
      '$.status',
      'FINAL requires FINAL finality, READY filing status and no limitations',
    )
  }
  const issuedAt = requiredString(record, 'issuedAt', '$')
  if (
    !RFC3339_UTC_PATTERN.test(issuedAt) ||
    !Number.isFinite(Date.parse(issuedAt))
  ) {
    invalid('$.issuedAt', 'must be an RFC 3339 UTC timestamp')
  }
  return {
    schemaVersion: REPORT_SCHEMA_V1,
    reportId,
    inputDigest: digestString(record, 'inputDigest', '$'),
    subjectId: requiredString(record, 'subjectId', '$'),
    residentId: requiredString(record, 'residentId', '$'),
    taxYear: integer(record, 'taxYear', '$', 2027, 9999),
    finality,
    status,
    filingStatus,
    taxInventoryRunId: requiredString(record, 'taxInventoryRunId', '$'),
    taxEstimateId: requiredString(record, 'taxEstimateId', '$'),
    lotRunId: requiredString(record, 'lotRunId', '$'),
    generationId: requiredString(record, 'generationId', '$'),
    schemaDigest: digestString(record, 'schemaDigest', '$'),
    denominationAssetId: requiredString(
      record,
      'denominationAssetId',
      '$',
    ),
    evidencePackDigest: digestString(record, 'evidencePackDigest', '$'),
    counts,
    summary,
    disposals,
    transfers,
    excludedConversions,
    limitations,
    policy: parseProducer(record.policy, '$.policy'),
    engine: parseProducer(record.engine, '$.engine'),
    issuedAt,
  }
}

const assertUnicodeScalarString = (value: string, path: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) {
        invalid(path, 'contains an unpaired high surrogate')
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      invalid(path, 'contains an unpaired low surrogate')
    }
  }
}

const canonicalStringify = (value: unknown, path = '$'): string => {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return invalid(path, 'contains a non-finite number')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, path)
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((child, index) =>
        canonicalStringify(child, `${path}[${index}]`),
      )
      .join(',')}]`
  }
  if (!isRecord(value)) {
    return invalid(path, 'contains a non-JSON value')
  }
  const keys = Object.keys(value).sort()
  return `{${keys
    .map((key) => {
      assertUnicodeScalarString(key, `${path} key`)
      return `${JSON.stringify(key)}:${canonicalStringify(
        value[key],
        `${path}.${key}`,
      )}`
    })
    .join(',')}}`
}

const parseArtifactEnvelope = (
  value: TaxReportModelArtifact,
  expectedReportId: string,
) => {
  const record = exactRecord(value, 'artifact', [
    'reportId',
    'artifactDigest',
    'mediaType',
    'canonicalJson',
  ])
  const reportId = requiredString(record, 'reportId', 'artifact')
  if (reportId !== expectedReportId) {
    invalid('artifact.reportId', 'does not match the requested report')
  }
  const artifactDigest = digestString(
    record,
    'artifactDigest',
    'artifact',
  )
  const mediaType = requiredString(record, 'mediaType', 'artifact')
  if (mediaType !== TAX_REPORT_MODEL_V1_MEDIA_TYPE) {
    invalid(
      'artifact.mediaType',
      `must equal ${TAX_REPORT_MODEL_V1_MEDIA_TYPE}`,
    )
  }
  const canonicalJsonValue = record.canonicalJson
  if (!isByteArray(canonicalJsonValue)) {
    return invalid('artifact.canonicalJson', 'must be bytes')
  }
  const canonicalJson = canonicalJsonValue
  if (
    canonicalJson.byteLength === 0 ||
    canonicalJson.byteLength > MAX_CANONICAL_JSON_BYTES
  ) {
    invalid(
      'artifact.canonicalJson',
      `must contain 1-${MAX_CANONICAL_JSON_BYTES} bytes`,
    )
  }
  const actualDigest = createHash('sha256')
    .update(canonicalJson)
    .digest('hex')
  if (actualDigest !== artifactDigest) {
    invalid('artifact.artifactDigest', 'does not match canonicalJson')
  }
  return { artifactDigest, canonicalJson }
}

const publicAmount = (value: CanonicalAmountV1): PublicAmount =>
  value.status === 'KNOWN'
    ? { status: value.status, amount: value.amount, hasAmount: true }
    : { status: value.status, amount: null, hasAmount: false }

const sumAmounts = (
  values: readonly CanonicalAmountV1[],
): PublicAmount => {
  if (values.some((value) => value.status === 'UNKNOWN')) {
    return { status: 'UNKNOWN', amount: null, hasAmount: false }
  }
  const amount = values.reduce(
    (total, value) =>
      total + BigInt(value.status === 'KNOWN' ? value.amount : '0'),
    0n,
  )
  return { status: 'KNOWN', amount: amount.toString(), hasAmount: true }
}

const assetSummaries = (
  disposals: readonly CanonicalDisposalRowV1[],
): PublicTaxReportDetail['assetSummaries'] => {
  const groups = new Map<string, CanonicalDisposalRowV1[]>()
  for (const disposal of disposals) {
    const group = groups.get(disposal.taxAssetId) ?? []
    group.push(disposal)
    groups.set(disposal.taxAssetId, group)
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([taxAssetId, rows]) => ({
      taxAssetId,
      disposalCount: rows.length,
      quantity: rows
        .reduce((total, row) => total + BigInt(row.quantity), 0n)
        .toString(),
      grossProceeds: sumAmounts(rows.map((row) => row.grossProceeds)),
      acquisitionCost: sumAmounts(rows.map((row) => row.basis)),
      ancillaryExpense: sumAmounts(
        rows.map((row) => row.ancillaryExpense),
      ),
      gainLoss: sumAmounts(rows.map((row) => row.gainLoss)),
    }))
}

const publicProjection = (
  model: CanonicalTaxReportModelV1,
  reportModelDigest: string,
): PublicTaxReportDetail => {
  const disposals = model.disposals.map((row) => ({
    movementId: row.movementId,
    eventId: row.eventId,
    revisionId: row.revisionId,
    legId: row.legId,
    taxAddressId: row.taxAddressId,
    taxAssetId: row.taxAssetId,
    ledgerAssetId: row.ledgerAssetId,
    quantity: row.quantity,
    grossProceeds: publicAmount(row.grossProceeds),
    ancillaryExpense: publicAmount(row.ancillaryExpense),
    basis: publicAmount(row.basis),
    gainLoss: publicAmount(row.gainLoss),
    valuationId: row.valuationId ?? null,
    costMethod: row.costMethod,
    rounding: row.rounding ?? null,
  }))
  return {
    schemaVersion: model.schemaVersion,
    reportId: model.reportId,
    reportModelDigest,
    inputDigest: model.inputDigest,
    evidencePackDigest: model.evidencePackDigest,
    taxYear: model.taxYear,
    finality: model.finality,
    status: model.status,
    filingStatus: model.filingStatus,
    denominationAssetId: model.denominationAssetId,
    counts: model.counts,
    summary: {
      gainLoss: publicAmount(model.summary.gainLoss),
      taxableBase: publicAmount(model.summary.taxableBase),
      nationalTax: publicAmount(model.summary.nationalTax),
      localTax: publicAmount(model.summary.localTax),
      totalTax: publicAmount(model.summary.totalTax),
    },
    totals: {
      grossProceeds: sumAmounts(
        model.disposals.map((row) => row.grossProceeds),
      ),
      acquisitionCost: sumAmounts(
        model.disposals.map((row) => row.basis),
      ),
      ancillaryExpense: sumAmounts(
        model.disposals.map((row) => row.ancillaryExpense),
      ),
      gainLoss: sumAmounts(
        model.disposals.map((row) => row.gainLoss),
      ),
    },
    assetSummaries: assetSummaries(model.disposals),
    disposals,
    transfers: model.transfers.map((row) => ({
      movementId: row.movementId,
      eventId: row.eventId,
      revisionId: row.revisionId,
      fromLegId: row.fromLegId,
      toLegId: row.toLegId,
      fromAddressId: row.fromAddressId,
      toAddressId: row.toAddressId,
      taxAssetId: row.taxAssetId,
      quantity: row.quantity,
      basis: publicAmount(row.basis),
      fromCostMethod: row.fromCostMethod,
      toCostMethod: row.toCostMethod,
    })),
    excludedConversions: model.excludedConversions.map((row) => ({
      eventId: row.eventId,
      revisionId: row.revisionId,
      relationId: row.relationId,
      taxAddressId: row.taxAddressId,
      taxAssetId: row.taxAssetId,
      fromLegId: row.fromLegId,
      toLegId: row.toLegId,
      fromQuantity: row.fromQuantity,
      toQuantity: row.toQuantity,
    })),
    limitations: model.limitations.map((row) => ({
      code: row.code,
      taxAddressId: row.taxAddressId ?? null,
      taxAssetId: row.taxAssetId ?? null,
      movementId: row.movementId ?? null,
      reason: row.reason,
      reviewId: row.reviewId ?? null,
      reviewRevisionId: row.reviewRevisionId ?? null,
    })),
    methodology: {
      taxInventoryRunId: model.taxInventoryRunId,
      taxEstimateId: model.taxEstimateId,
      lotRunId: model.lotRunId,
      generationId: model.generationId,
      schemaDigest: model.schemaDigest,
      policy: model.policy,
      engine: model.engine,
    },
    issuedAt: model.issuedAt,
  }
}

export const decodeAndProjectTaxReportModel = (
  artifact: TaxReportModelArtifact,
  expectedReportId: string,
): PublicTaxReportDetail => {
  try {
    if (!REPORT_ID_PATTERN.test(expectedReportId)) {
      invalid('expectedReportId', 'must be a canonical tax report ID')
    }
    const { artifactDigest, canonicalJson } = parseArtifactEnvelope(
      artifact,
      expectedReportId,
    )
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(canonicalJson)
    } catch {
      return invalid('artifact.canonicalJson', 'must be valid UTF-8')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return invalid('artifact.canonicalJson', 'must be valid JSON')
    }
    if (canonicalStringify(parsed) !== text) {
      invalid(
        'artifact.canonicalJson',
        'must be exact RFC 8785 canonical JSON',
      )
    }
    const model = parseCanonicalModel(parsed, expectedReportId)
    return publicProjection(model, artifactDigest)
  } catch (error) {
    if (error instanceof InvalidTaxReportModelError) {
      throw error
    }
    throw new InvalidTaxReportModelError(
      'artifact.canonicalJson: validation failed',
    )
  }
}

const publicAmountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'amount', 'hasAmount'],
  properties: {
    status: { type: 'string', enum: ['KNOWN', 'UNKNOWN'] },
    amount: {
      anyOf: [
        { type: 'string', pattern: '^-?(0|[1-9][0-9]{0,77})$' },
        { type: 'null' },
      ],
    },
    hasAmount: { type: 'boolean' },
  },
} as const

const nullableStringSchema = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const

const producerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'version', 'artifactDigest'],
  properties: {
    name: { type: 'string' },
    version: { type: 'string' },
    artifactDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
} as const

export const publicTaxReportDetailSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'reportId',
    'reportModelDigest',
    'inputDigest',
    'evidencePackDigest',
    'taxYear',
    'finality',
    'status',
    'filingStatus',
    'denominationAssetId',
    'counts',
    'summary',
    'totals',
    'assetSummaries',
    'disposals',
    'transfers',
    'excludedConversions',
    'limitations',
    'methodology',
    'issuedAt',
  ],
  properties: {
    schemaVersion: { type: 'string', const: REPORT_SCHEMA_V1 },
    reportId: {
      type: 'string',
      pattern: '^tax-report:[0-9a-f]{64}$',
    },
    reportModelDigest: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    inputDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    evidencePackDigest: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    },
    taxYear: { type: 'integer', minimum: 2027, maximum: 9999 },
    finality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    status: { type: 'string', enum: ['FINAL', 'PARTIAL'] },
    filingStatus: { type: 'string', enum: ['READY', 'BLOCKED'] },
    denominationAssetId: { type: 'string' },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: [
        'disposals',
        'transfers',
        'excludedConversions',
        'limitations',
      ],
      properties: {
        disposals: { type: 'integer', minimum: 0 },
        transfers: { type: 'integer', minimum: 0 },
        excludedConversions: { type: 'integer', minimum: 0 },
        limitations: { type: 'integer', minimum: 0 },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: [
        'gainLoss',
        'taxableBase',
        'nationalTax',
        'localTax',
        'totalTax',
      ],
      properties: {
        gainLoss: publicAmountSchema,
        taxableBase: publicAmountSchema,
        nationalTax: publicAmountSchema,
        localTax: publicAmountSchema,
        totalTax: publicAmountSchema,
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      required: [
        'grossProceeds',
        'acquisitionCost',
        'ancillaryExpense',
        'gainLoss',
      ],
      properties: {
        grossProceeds: publicAmountSchema,
        acquisitionCost: publicAmountSchema,
        ancillaryExpense: publicAmountSchema,
        gainLoss: publicAmountSchema,
      },
    },
    assetSummaries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'taxAssetId',
          'disposalCount',
          'quantity',
          'grossProceeds',
          'acquisitionCost',
          'ancillaryExpense',
          'gainLoss',
        ],
        properties: {
          taxAssetId: { type: 'string' },
          disposalCount: { type: 'integer', minimum: 1 },
          quantity: {
            type: 'string',
            pattern: '^[1-9][0-9]{0,77}$',
          },
          grossProceeds: publicAmountSchema,
          acquisitionCost: publicAmountSchema,
          ancillaryExpense: publicAmountSchema,
          gainLoss: publicAmountSchema,
        },
      },
    },
    disposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'movementId',
          'eventId',
          'revisionId',
          'legId',
          'taxAddressId',
          'taxAssetId',
          'ledgerAssetId',
          'quantity',
          'grossProceeds',
          'ancillaryExpense',
          'basis',
          'gainLoss',
          'valuationId',
          'costMethod',
          'rounding',
        ],
        properties: {
          movementId: { type: 'string' },
          eventId: { type: 'string' },
          revisionId: { type: 'string' },
          legId: { type: 'string' },
          taxAddressId: { type: 'string' },
          taxAssetId: { type: 'string' },
          ledgerAssetId: { type: 'string' },
          quantity: {
            type: 'string',
            pattern: '^[1-9][0-9]{0,77}$',
          },
          grossProceeds: publicAmountSchema,
          ancillaryExpense: publicAmountSchema,
          basis: publicAmountSchema,
          gainLoss: publicAmountSchema,
          valuationId: nullableStringSchema,
          costMethod: { type: 'string' },
          rounding: nullableStringSchema,
        },
      },
    },
    transfers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'movementId',
          'eventId',
          'revisionId',
          'fromLegId',
          'toLegId',
          'fromAddressId',
          'toAddressId',
          'taxAssetId',
          'quantity',
          'basis',
          'fromCostMethod',
          'toCostMethod',
        ],
        properties: {
          movementId: { type: 'string' },
          eventId: { type: 'string' },
          revisionId: { type: 'string' },
          fromLegId: { type: 'string' },
          toLegId: { type: 'string' },
          fromAddressId: { type: 'string' },
          toAddressId: { type: 'string' },
          taxAssetId: { type: 'string' },
          quantity: {
            type: 'string',
            pattern: '^[1-9][0-9]{0,77}$',
          },
          basis: publicAmountSchema,
          fromCostMethod: { type: 'string' },
          toCostMethod: { type: 'string' },
        },
      },
    },
    excludedConversions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'eventId',
          'revisionId',
          'relationId',
          'taxAddressId',
          'taxAssetId',
          'fromLegId',
          'toLegId',
          'fromQuantity',
          'toQuantity',
        ],
        properties: {
          eventId: { type: 'string' },
          revisionId: { type: 'string' },
          relationId: { type: 'string' },
          taxAddressId: { type: 'string' },
          taxAssetId: { type: 'string' },
          fromLegId: { type: 'string' },
          toLegId: { type: 'string' },
          fromQuantity: {
            type: 'string',
            pattern: '^[1-9][0-9]{0,77}$',
          },
          toQuantity: {
            type: 'string',
            pattern: '^[1-9][0-9]{0,77}$',
          },
        },
      },
    },
    limitations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'code',
          'taxAddressId',
          'taxAssetId',
          'movementId',
          'reason',
          'reviewId',
          'reviewRevisionId',
        ],
        properties: {
          code: { type: 'string' },
          taxAddressId: nullableStringSchema,
          taxAssetId: nullableStringSchema,
          movementId: nullableStringSchema,
          reason: { type: 'string' },
          reviewId: nullableStringSchema,
          reviewRevisionId: nullableStringSchema,
        },
      },
    },
    methodology: {
      type: 'object',
      additionalProperties: false,
      required: [
        'taxInventoryRunId',
        'taxEstimateId',
        'lotRunId',
        'generationId',
        'schemaDigest',
        'policy',
        'engine',
      ],
      properties: {
        taxInventoryRunId: { type: 'string' },
        taxEstimateId: { type: 'string' },
        lotRunId: { type: 'string' },
        generationId: { type: 'string' },
        schemaDigest: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        policy: producerSchema,
        engine: producerSchema,
      },
    },
    issuedAt: { type: 'string', format: 'date-time' },
  },
} as const
