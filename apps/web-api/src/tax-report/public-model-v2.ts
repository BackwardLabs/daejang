import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

import {
  TAX_REPORT_MODEL_V2_MEDIA_TYPE,
  type TaxReportModelArtifact,
} from './model-reader.js'

export const REPORT_SCHEMA_V2 = 'giwa.tax-report-model.v2' as const

const DIGEST = /^[0-9a-f]{64}$/
const REPORT_ID = /^tax-report-v2:[0-9a-f]{64}$/
const INTEGER = /^-?(0|[1-9][0-9]{0,77})$/
const UNSIGNED = /^(0|[1-9][0-9]{0,77})$/
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 100_000

type JsonRecord = Record<string, unknown>

export type PublicTaxReportV2Amount =
  | { status: 'KNOWN'; amount: string; hasAmount: true }
  | { status: 'UNKNOWN'; amount: null; hasAmount: false }

export type PublicTaxReportV2Interval = { from: string; through: string }

export type PublicTaxReportV2Policy = {
  name: string
  version: string
  artifactDigest: string
  sourceSetDigest: string
  applicationMode: 'ENACTED' | 'SIMULATION'
  effectiveFrom: string
  effectiveThrough: string
  denominationAtomicDecimals: number
  roundingProfileStatus: 'APPROVED' | 'ESTIMATE_ONLY_UNAPPROVED'
  roundingProfileEvidenceDigest: string | null
  legalReferences: Array<{
    law: string
    article: string
    paragraphs: string[]
    purpose: string
    sourceLocators: string[]
    sourceCheckedAt: string | null
  }>
}

export type PublicTaxReportV2SourceCoverage = {
  sourceArtifactId: string
  sourceKind: string
  systemName: string | null
  assurance:
    | 'UNKNOWN'
    | 'USER_DECLARED'
    | 'DOCUMENT_METADATA_VERIFIED'
    | 'CHAIN_VERIFIED'
  status: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
  evidenceDigest: string
  fragmentIds: string[]
  coveredIntervals: PublicTaxReportV2Interval[]
  uncoveredIntervals: PublicTaxReportV2Interval[]
}

export type PublicTaxReportV2AssetSummary = {
  taxAssetId: string
  openingQuantity: string
  openingBasis: PublicTaxReportV2Amount
  openingBasisProvenance: {
    status: 'NOT_APPLICABLE' | 'UNKNOWN' | 'KNOWN'
    basisRule: string | null
    actualAcquisitionAmount: string | null
    marketValueAt2026End: string | null
    sourceRunId: string | null
  }
  acquiredQuantity: string
  acquisitionCost: PublicTaxReportV2Amount
  annualAverage: {
    status: 'KNOWN' | 'UNKNOWN' | 'NOT_APPLICABLE'
    numerator: string | null
    denominator: string | null
    unitCost: string | null
    unitCostNumerator: string | null
    unitCostDenominator: string | null
    rounding: string | null
  }
  disposedQuantity: string
  grossProceeds: PublicTaxReportV2Amount
  incurredExpense: PublicTaxReportV2Amount
  deductibleExpense: PublicTaxReportV2Amount
  disposedBasis: PublicTaxReportV2Amount
  gainLoss: PublicTaxReportV2Amount
  endingQuantity: string
  endingCost: PublicTaxReportV2Amount
  basisMode: 'ACTUAL_TOTAL_AVERAGE' | 'DEEMED_EXPENSE_50'
  basisEvidenceDigest: string | null
}

export type PublicTaxReportV2Account = {
  status: 'UNKNOWN' | 'PARTIAL' | 'KNOWN'
  accountId: string | null
  accountKind: string | null
  displayNameStatus: 'UNKNOWN'
  displayName: string | null
}

export type PublicTaxReportV2Valuation = {
  status: 'UNKNOWN' | 'PARTIAL' | 'KNOWN'
  valuationId: string | null
  kind: string | null
  effectiveAt: string | null
  quoteId: string | null
  snapshotArtifactDigest: string | null
  baseAtomicUnits: string | null
  quoteAtomicUnits: string | null
  rounding: string | null
  providerStatus: 'UNKNOWN' | 'KNOWN'
  provider: string | null
  datasetVersionStatus: 'UNKNOWN' | 'KNOWN'
  datasetVersion: string | null
  marketStatus: 'UNKNOWN' | 'KNOWN' | 'NOT_APPLICABLE'
  market: string | null
}

export type PublicTaxReportV2SourceEvidence = {
  legId: string | null
  relationId: string | null
  fragmentId: string
  observationId: string
  sourceArtifactBindingStatus: 'BOUND' | 'UNBOUND'
  sourceArtifactIds: string[]
  sourceKinds: string[]
}

export type PublicTaxReportV2RowReview = {
  status: 'CLEAR' | 'REVIEW_REQUIRED'
  limitations: PublicTaxReportV2Detail['limitations']
}

type PublicMovementBase = {
  transactionType: string
  movementId: string
  relatedMovementId: string | null
  eventId: string
  revisionId: string
  legId: string
  kind: string
  taxAssetId: string
  ledgerAssetId: string
  quantity: string
  valuationId: string | null
  occurredAt: string
  account: PublicTaxReportV2Account
  valuation: PublicTaxReportV2Valuation
  sourceEvidence: PublicTaxReportV2SourceEvidence[]
  review: PublicTaxReportV2RowReview
}

type PublicAcquisitionKind = 'ACQUIRE' | 'OTHER_ACQUISITION'
type PublicIncomeKind = 'LENDING_INCOME_CASH' | 'LENDING_INCOME_ASSET'

export type PublicTaxReportV2Detail = {
  schemaVersion: typeof REPORT_SCHEMA_V2
  reportId: string
  reportModelDigest: string
  inputDigest: string
  evidencePackDigest: string
  taxYear: number
  status: 'FINAL' | 'PARTIAL'
  calculationStatus: 'COMPLETE' | 'BLOCKED'
  taxOutcome:
    | 'INCOMPLETE'
    | 'NO_TAX_EVENTS'
    | 'TAX_ZERO'
    | 'ESTIMATED_TAX_ZERO'
    | 'ESTIMATED_TAX_DUE'
    | 'TAX_DUE'
    | 'SIMULATED_TAX_ZERO'
    | 'SIMULATED_TAX_DUE'
  filingAction:
    | 'BLOCKED'
    | 'REVIEW_REQUIRED'
    | 'FILING_ACTION_REQUIRED'
    | 'FILING_NOT_APPLICABLE'
  filingStatus: 'READY' | 'BLOCKED'
  filingSubmissionStatus: 'UNKNOWN' | 'NOT_APPLICABLE'
  inputPeriod: PublicTaxReportV2Interval
  dataCoverage: {
    status: 'UNKNOWN' | 'PARTIAL' | 'COMPLETE'
    assurance:
      | 'UNKNOWN'
      | 'USER_DECLARED'
      | 'DOCUMENT_METADATA_VERIFIED'
      | 'CHAIN_VERIFIED'
    from: string
    through: string
    declaration: string | null
    coveredIntervals: PublicTaxReportV2Interval[]
    uncoveredIntervals: PublicTaxReportV2Interval[]
  }
  calculatedAsOf: string
  taxYearCloseStatus: 'OPEN' | 'CLOSED'
  valuationFinality: 'FINAL' | 'PROVISIONAL'
  reportFinality: 'FINAL' | 'PROVISIONAL'
  denominationAssetId: string
  denominationAtomicDecimals: number
  counts: {
    assetSummaries: number
    disposals: number
    feeAssetDisposals: number
    acquisitions: number
    incomeRows: number
    nonTaxableTransfers: number
    transfers: number
    limitations: number
    sourceArtifacts: number
  }
  summary: {
    grossProceeds: PublicTaxReportV2Amount
    disposedBasis: PublicTaxReportV2Amount
    deductibleExpense: PublicTaxReportV2Amount
    incurredExpense: PublicTaxReportV2Amount
    disposalGainLoss: PublicTaxReportV2Amount
    lendingIncome: PublicTaxReportV2Amount
    lendingExpense: PublicTaxReportV2Amount
    netLendingIncome: PublicTaxReportV2Amount
    taxableIncome: PublicTaxReportV2Amount
    taxableBase: PublicTaxReportV2Amount
    nationalTax: PublicTaxReportV2Amount
    localTax: PublicTaxReportV2Amount
    totalTax: PublicTaxReportV2Amount
    calculationRule: {
      poolScope: 'RESIDENT_TAX_YEAR_TAX_ASSET'
      costMethods: ['ANNUAL_TOTAL_AVERAGE']
      basicDeductionAmount: string
      deductionUsedAmount: string | null
      nationalRate: { numerator: string; denominator: string }
      localRate: { numerator: string; denominator: string }
      taxRounding: 'FLOOR'
      basisAllocationRounding: 'CUMULATIVE_FLOOR_ANNUAL_POOL'
    }
  }
  assetSummaries: PublicTaxReportV2AssetSummary[]
  disposals: Array<{
    transactionType: 'DISPOSAL' | 'FEE_ASSET_DISPOSAL'
    movementId: string
    relatedMovementId: string | null
    eventId: string
    revisionId: string
    legId: string
    taxAddressId: string
    taxAssetId: string
    ledgerAssetId: string
    quantity: string
    grossProceeds: PublicTaxReportV2Amount
    ancillaryExpense: PublicTaxReportV2Amount
    incurredExpense: PublicTaxReportV2Amount
    basis: PublicTaxReportV2Amount
    gainLoss: PublicTaxReportV2Amount
    valuationId: string | null
    costMethod: string
    rounding: string | null
    basisMode: 'ACTUAL_TOTAL_AVERAGE' | 'DEEMED_EXPENSE_50'
    basisEvidenceDigest: string | null
    occurredAt: string
    account: PublicTaxReportV2Account
    valuation: PublicTaxReportV2Valuation
    sourceEvidence: PublicTaxReportV2SourceEvidence[]
    review: PublicTaxReportV2RowReview
  }>
  feeAssetDisposals: PublicTaxReportV2Detail['disposals']
  acquisitions: Array<PublicMovementBase & {
    transactionType: PublicAcquisitionKind
    kind: PublicAcquisitionKind
    consideration: PublicTaxReportV2Amount
    acquisitionAncillaryExpense: PublicTaxReportV2Amount
    acquisitionCost: PublicTaxReportV2Amount
  }>
  incomeRows: Array<PublicMovementBase & {
    transactionType: PublicIncomeKind
    kind: PublicIncomeKind
    income: PublicTaxReportV2Amount
    ancillaryExpense: PublicTaxReportV2Amount
  }>
  transfers: Array<{
    transactionType: 'TRANSFER'
    movementId: string
    eventId: string
    revisionId: string
    fromLegId: string
    toLegId: string
    fromAddressId: string
    toAddressId: string
    taxAssetId: string
    quantity: string
    basis: PublicTaxReportV2Amount
    fromCostMethod: string
    toCostMethod: string
    occurredAt: string
    from: PublicTaxReportV2Account
    to: PublicTaxReportV2Account
    sourceEvidence: PublicTaxReportV2SourceEvidence[]
    review: PublicTaxReportV2RowReview
  }>
  nonTaxableTransfers: Array<{
    transactionType: 'SELF_TRANSFER'
    movementId: string
    eventId: string
    revisionId: string
    fromLegId: string
    toLegId: string
    taxAssetId: string
    quantity: string
    occurredAt: string
    from: PublicTaxReportV2Account
    to: PublicTaxReportV2Account
    sourceEvidence: PublicTaxReportV2SourceEvidence[]
    review: PublicTaxReportV2RowReview
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
    reason: string
    taxAddressId: string | null
    taxAssetId: string | null
    movementId: string | null
    reviewId: string | null
    reviewRevisionId: string | null
  }>
  sourceCoverage: PublicTaxReportV2SourceCoverage[]
  methodology: {
    taxInventoryRunId: string
    taxEstimateId: string
    lotRunId: string
    sourceLedgerGenerationId: string
    schemaDigest: string
    policy: PublicTaxReportV2Policy
    engine: { name: string; version: string; artifactDigest: string }
  }
  issuedAt: string
}

export class InvalidTaxReportModelV2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaxReportModelV2Error'
  }
}

const invalid = (path: string, message: string): never => {
  throw new InvalidTaxReportModelV2Error(`${path}: ${message}`)
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const record = (
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonRecord => {
  if (!isRecord(value)) invalid(path, 'must be an object')
  const result = value as JsonRecord
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not allowed')
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) invalid(`${path}.${key}`, 'is required')
  }
  return result
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(path, 'must be a non-empty string')
  }
  return value as string
}

const optionalString = (value: unknown, path: string): string | null =>
  value === undefined ? null : string(value, path)

const oneOf = <T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
) => {
  const parsed = string(value, path)
  if (!values.includes(parsed as T)) {
    invalid(path, `must be one of ${values.join(', ')}`)
  }
  return parsed as T
}

const digest = (value: unknown, path: string): string => {
  const parsed = string(value, path)
  if (!DIGEST.test(parsed)) invalid(path, 'must be a lowercase SHA-256 digest')
  return parsed
}

const numeric = (value: unknown, path: string, unsigned = false): string => {
  const parsed = string(value, path)
  if (!(unsigned ? UNSIGNED : INTEGER).test(parsed)) {
    invalid(path, 'must be a canonical base-10 integer')
  }
  return parsed
}

const timestamp = (value: unknown, path: string): string => {
  const parsed = string(value, path)
  if (!RFC3339.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    invalid(path, 'must be an RFC 3339 UTC timestamp')
  }
  return parsed
}

const legalSourceLocator = (value: unknown, path: string): string => {
  const parsed = string(value, path)
  let url: URL
  try {
    url = new URL(parsed)
  } catch {
    return invalid(path, 'must be an absolute URL')
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'law.go.kr' && url.hostname !== 'www.law.go.kr') ||
    url.username !== '' ||
    url.password !== ''
  ) {
    invalid(path, 'must be an official HTTPS law.go.kr URL')
  }
  return parsed
}

const integer = (value: unknown, path: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_ROWS) {
    invalid(path, `must be an integer between 0 and ${MAX_ROWS}`)
  }
  return value as number
}

const array = <T>(
  value: unknown,
  path: string,
  parse: (row: unknown, path: string) => T,
) => {
  if (!Array.isArray(value) || value.length > MAX_ROWS) {
    invalid(path, `must be an array with at most ${MAX_ROWS} rows`)
  }
  return (value as unknown[]).map((row, index) =>
    parse(row, `${path}[${index}]`),
  )
}

const stringArray = (value: unknown, path: string) => {
  const parsed = array(value, path, string)
  if (new Set(parsed).size !== parsed.length) invalid(path, 'must be unique')
  return parsed
}

const amount = (value: unknown, path: string): PublicTaxReportV2Amount => {
  const row = record(value, path, ['status'], ['amount'])
  const status = oneOf(row.status, `${path}.status`, ['KNOWN', 'UNKNOWN'])
  if (status === 'UNKNOWN') {
    if (Object.hasOwn(row, 'amount')) invalid(`${path}.amount`, 'must be omitted')
    return { status, amount: null, hasAmount: false }
  }
  if (!Object.hasOwn(row, 'amount')) invalid(`${path}.amount`, 'is required')
  return {
    status,
    amount: numeric(row.amount, `${path}.amount`),
    hasAmount: true,
  }
}

const interval = (value: unknown, path: string): PublicTaxReportV2Interval => {
  const row = record(value, path, ['from', 'through'])
  const from = timestamp(row.from, `${path}.from`)
  const through = timestamp(row.through, `${path}.through`)
  if (Date.parse(through) < Date.parse(from)) invalid(path, 'is reversed')
  return { from, through }
}

const producer = (value: unknown, path: string) => {
  const row = record(value, path, ['name', 'version', 'artifactDigest'])
  return {
    name: string(row.name, `${path}.name`),
    version: string(row.version, `${path}.version`),
    artifactDigest: digest(row.artifactDigest, `${path}.artifactDigest`),
  }
}

const policy = (value: unknown, path: string): PublicTaxReportV2Policy => {
  const row = record(value, path, [
    'name', 'version', 'artifactDigest', 'sourceSetDigest',
    'applicationMode', 'effectiveFrom', 'effectiveThrough',
    'denominationAtomicDecimals', 'roundingProfileStatus', 'legalReferences',
  ], ['roundingProfileEvidenceDigest'])
  const legalReferences = array(
    row.legalReferences,
    `${path}.legalReferences`,
    (value, legalPath) => {
      const legal = record(
        value,
        legalPath,
        ['law', 'article', 'purpose'],
        ['paragraphs', 'sourceLocators', 'sourceCheckedAt'],
      )
      const sourceLocators = legal.sourceLocators === undefined
        ? []
        : array(legal.sourceLocators, `${legalPath}.sourceLocators`, legalSourceLocator)
      if (new Set(sourceLocators).size !== sourceLocators.length) {
        invalid(`${legalPath}.sourceLocators`, 'must be unique')
      }
      return {
        law: string(legal.law, `${legalPath}.law`),
        article: string(legal.article, `${legalPath}.article`),
        paragraphs: legal.paragraphs === undefined
          ? []
          : stringArray(legal.paragraphs, `${legalPath}.paragraphs`),
        purpose: string(legal.purpose, `${legalPath}.purpose`),
        sourceLocators,
        sourceCheckedAt: legal.sourceCheckedAt === undefined
          ? null
          : timestamp(legal.sourceCheckedAt, `${legalPath}.sourceCheckedAt`),
      }
    },
  )
  if (legalReferences.length === 0) invalid(`${path}.legalReferences`, 'must not be empty')
  const roundingProfileStatus = oneOf(
    row.roundingProfileStatus,
    `${path}.roundingProfileStatus`,
    ['APPROVED', 'ESTIMATE_ONLY_UNAPPROVED'],
  )
  const roundingProfileEvidenceDigest = row.roundingProfileEvidenceDigest === undefined
    ? null
    : digest(row.roundingProfileEvidenceDigest, `${path}.roundingProfileEvidenceDigest`)
  if (
    (roundingProfileStatus === 'APPROVED' && roundingProfileEvidenceDigest === null) ||
    (roundingProfileStatus === 'ESTIMATE_ONLY_UNAPPROVED' &&
      roundingProfileEvidenceDigest !== null)
  ) {
    invalid(path, 'rounding profile approval and evidence disagree')
  }
  return {
    name: string(row.name, `${path}.name`),
    version: string(row.version, `${path}.version`),
    artifactDigest: digest(row.artifactDigest, `${path}.artifactDigest`),
    sourceSetDigest: digest(row.sourceSetDigest, `${path}.sourceSetDigest`),
    applicationMode: oneOf(row.applicationMode, `${path}.applicationMode`, ['ENACTED', 'SIMULATION']),
    effectiveFrom: timestamp(row.effectiveFrom, `${path}.effectiveFrom`),
    effectiveThrough: timestamp(row.effectiveThrough, `${path}.effectiveThrough`),
    denominationAtomicDecimals: (() => {
      const decimals = integer(
        row.denominationAtomicDecimals,
        `${path}.denominationAtomicDecimals`,
      )
      if (decimals < 1 || decimals > 18) {
        invalid(`${path}.denominationAtomicDecimals`, 'must be between 1 and 18')
      }
      return decimals
    })(),
    roundingProfileStatus,
    roundingProfileEvidenceDigest,
    legalReferences,
  }
}

const rate = (value: unknown, path: string) => {
  const row = record(value, path, ['numerator', 'denominator'])
  const denominator = numeric(row.denominator, `${path}.denominator`, true)
  if (denominator === '0') invalid(`${path}.denominator`, 'must be positive')
  return {
    numerator: numeric(row.numerator, `${path}.numerator`, true),
    denominator,
  }
}

const calculationRule = (value: unknown, path: string) => {
  const row = record(value, path, [
    'poolScope', 'costMethods', 'basicDeductionAmount', 'nationalRate',
    'localRate', 'taxRounding', 'basisAllocationRounding',
  ], ['deductionUsedAmount'])
  const methods = stringArray(row.costMethods, `${path}.costMethods`)
  if (methods.length !== 1 || methods[0] !== 'ANNUAL_TOTAL_AVERAGE') {
    invalid(`${path}.costMethods`, 'must declare only ANNUAL_TOTAL_AVERAGE')
  }
  return {
    poolScope: oneOf(row.poolScope, `${path}.poolScope`, ['RESIDENT_TAX_YEAR_TAX_ASSET']),
    costMethods: ['ANNUAL_TOTAL_AVERAGE'] as ['ANNUAL_TOTAL_AVERAGE'],
    basicDeductionAmount: numeric(row.basicDeductionAmount, `${path}.basicDeductionAmount`, true),
    deductionUsedAmount: row.deductionUsedAmount === undefined
      ? null
      : numeric(row.deductionUsedAmount, `${path}.deductionUsedAmount`, true),
    nationalRate: rate(row.nationalRate, `${path}.nationalRate`),
    localRate: rate(row.localRate, `${path}.localRate`),
    taxRounding: oneOf(row.taxRounding, `${path}.taxRounding`, ['FLOOR']),
    basisAllocationRounding: oneOf(
      row.basisAllocationRounding,
      `${path}.basisAllocationRounding`,
      ['CUMULATIVE_FLOOR_ANNUAL_POOL'],
    ),
  }
}

const average = (value: unknown, path: string) => {
  const row = record(value, path, ['status'], [
    'numerator', 'denominator', 'unitCost', 'unitCostNumerator',
    'unitCostDenominator', 'rounding',
  ])
  const status = oneOf(row.status, `${path}.status`, [
    'KNOWN', 'UNKNOWN', 'NOT_APPLICABLE',
  ])
  const result = {
    status,
    numerator: optionalString(row.numerator, `${path}.numerator`),
    denominator: optionalString(row.denominator, `${path}.denominator`),
    unitCost: optionalString(row.unitCost, `${path}.unitCost`),
    unitCostNumerator: optionalString(row.unitCostNumerator, `${path}.unitCostNumerator`),
    unitCostDenominator: optionalString(row.unitCostDenominator, `${path}.unitCostDenominator`),
    rounding: optionalString(row.rounding, `${path}.rounding`),
  }
  const values = Object.values(result).slice(1)
  if (status === 'KNOWN' && values.some((item) => item === null)) {
    invalid(path, 'KNOWN average requires exact numerator, denominator and rounding')
  }
  if (status !== 'KNOWN' && values.some((item) => item !== null)) {
    invalid(path, `${status} average must omit exact values`)
  }
  return result
}

const basisMode = (value: unknown, path: string) =>
  oneOf(value, path, ['ACTUAL_TOTAL_AVERAGE', 'DEEMED_EXPENSE_50'])

const basisDecision = (
  modeValue: unknown,
  evidenceValue: unknown,
  path: string,
) => {
  const mode = basisMode(modeValue, `${path}.basisMode`)
  const evidence = evidenceValue === undefined
    ? null
    : digest(evidenceValue, `${path}.basisEvidenceDigest`)
  if ((mode === 'DEEMED_EXPENSE_50') !== (evidence !== null)) {
    invalid(
      path,
      '50% deemed-expense mode and its statutory evidence must appear together',
    )
  }
  return { mode, evidence }
}

const account = (
  value: unknown,
  path: string,
): PublicTaxReportV2Account => {
  const row = record(value, path, ['status', 'displayNameStatus'], [
    'accountId', 'accountKind', 'displayName',
  ])
  const status = oneOf(row.status, `${path}.status`, [
    'UNKNOWN', 'PARTIAL', 'KNOWN',
  ])
  const accountId = optionalString(row.accountId, `${path}.accountId`)
  const accountKind = optionalString(row.accountKind, `${path}.accountKind`)
  const displayNameStatus = oneOf(
    row.displayNameStatus,
    `${path}.displayNameStatus`,
    ['UNKNOWN'],
  )
  const displayName = optionalString(row.displayName, `${path}.displayName`)
  if (
    (status === 'UNKNOWN' && (accountId !== null || accountKind !== null)) ||
    (status === 'PARTIAL' && accountId === null) ||
    (status === 'KNOWN' && (accountId === null || accountKind === null)) ||
    (accountKind !== null && accountId === null) ||
    displayName !== null
  ) {
    invalid(path, 'account completeness fields disagree')
  }
  return {
    status,
    accountId,
    accountKind,
    displayNameStatus,
    displayName,
  }
}

const valuation = (
  value: unknown,
  path: string,
): PublicTaxReportV2Valuation => {
  const row = record(value, path, ['status'], [
    'valuationId', 'kind', 'effectiveAt', 'quoteId',
    'snapshotArtifactDigest', 'baseAtomicUnits', 'quoteAtomicUnits',
    'rounding', 'providerStatus', 'provider', 'datasetVersionStatus',
    'datasetVersion', 'marketStatus', 'market',
  ])
  const status = oneOf(row.status, `${path}.status`, [
    'UNKNOWN', 'PARTIAL', 'KNOWN',
  ])
  const result: PublicTaxReportV2Valuation = {
    status,
    valuationId: optionalString(row.valuationId, `${path}.valuationId`),
    kind: optionalString(row.kind, `${path}.kind`),
    effectiveAt: row.effectiveAt === undefined
      ? null
      : timestamp(row.effectiveAt, `${path}.effectiveAt`),
    quoteId: optionalString(row.quoteId, `${path}.quoteId`),
    snapshotArtifactDigest: row.snapshotArtifactDigest === undefined
      ? null
      : digest(row.snapshotArtifactDigest, `${path}.snapshotArtifactDigest`),
    baseAtomicUnits: row.baseAtomicUnits === undefined
      ? null
      : numeric(row.baseAtomicUnits, `${path}.baseAtomicUnits`, true),
    quoteAtomicUnits: row.quoteAtomicUnits === undefined
      ? null
      : numeric(row.quoteAtomicUnits, `${path}.quoteAtomicUnits`, true),
    rounding: optionalString(row.rounding, `${path}.rounding`),
    providerStatus: oneOf(
      row.providerStatus,
      `${path}.providerStatus`,
      ['UNKNOWN', 'KNOWN'],
    ),
    provider: optionalString(row.provider, `${path}.provider`),
    datasetVersionStatus: oneOf(
      row.datasetVersionStatus,
      `${path}.datasetVersionStatus`,
      ['UNKNOWN', 'KNOWN'],
    ),
    datasetVersion: optionalString(
      row.datasetVersion,
      `${path}.datasetVersion`,
    ),
    marketStatus: oneOf(
      row.marketStatus,
      `${path}.marketStatus`,
      ['UNKNOWN', 'KNOWN', 'NOT_APPLICABLE'],
    ),
    market: optionalString(row.market, `${path}.market`),
  }
  const exactFields = [
    result.valuationId,
    result.kind,
    result.effectiveAt,
    result.quoteId,
    result.snapshotArtifactDigest,
    result.baseAtomicUnits,
    result.quoteAtomicUnits,
    result.rounding,
    result.provider,
    result.datasetVersion,
  ]
  const allTraceFields = [...exactFields, result.market]
  if (
    (status === 'UNKNOWN' &&
      (allTraceFields.some((field) => field !== null) ||
        result.providerStatus !== 'UNKNOWN' ||
        result.datasetVersionStatus !== 'UNKNOWN' ||
        result.marketStatus !== 'UNKNOWN')) ||
    (status !== 'UNKNOWN' && result.valuationId === null) ||
    (result.providerStatus === 'KNOWN') !== (result.provider !== null) ||
    (result.datasetVersionStatus === 'KNOWN') !==
      (result.datasetVersion !== null) ||
    (result.marketStatus === 'KNOWN') !== (result.market !== null) ||
    (status === 'KNOWN' &&
      (exactFields.some((field) => field === null) ||
        result.providerStatus !== 'KNOWN' ||
        result.datasetVersionStatus !== 'KNOWN' ||
        result.marketStatus === 'UNKNOWN'))
  ) {
    invalid(path, 'valuation completeness fields disagree')
  }
  return result
}

const valuationPair = (row: JsonRecord, path: string) => {
  const valuationId = optionalString(row.valuationId, `${path}.valuationId`)
  const trace = valuation(row.valuation, `${path}.valuation`)
  if (valuationId !== trace.valuationId) {
    invalid(path, 'valuation identity and nested trace must match exactly')
  }
  return { valuationId, valuation: trace }
}

const sourceEvidence = (
  value: unknown,
  path: string,
): PublicTaxReportV2SourceEvidence => {
  const row = record(value, path, [
    'fragmentId', 'observationId', 'sourceArtifactBindingStatus',
    'sourceArtifactIds', 'sourceKinds',
  ], ['legId', 'relationId'])
  const sourceArtifactBindingStatus = oneOf(
    row.sourceArtifactBindingStatus,
    `${path}.sourceArtifactBindingStatus`,
    ['BOUND', 'UNBOUND'],
  )
  const sourceArtifactIds = stringArray(
    row.sourceArtifactIds,
    `${path}.sourceArtifactIds`,
  )
  const sourceKinds = stringArray(row.sourceKinds, `${path}.sourceKinds`)
  if (
    (sourceArtifactBindingStatus === 'BOUND' && sourceArtifactIds.length === 0) ||
    (sourceArtifactBindingStatus === 'UNBOUND' && sourceArtifactIds.length !== 0)
  ) {
    invalid(path, 'source artifact binding fields disagree')
  }
  return {
    legId: optionalString(row.legId, `${path}.legId`),
    relationId: optionalString(row.relationId, `${path}.relationId`),
    fragmentId: string(row.fragmentId, `${path}.fragmentId`),
    observationId: string(row.observationId, `${path}.observationId`),
    sourceArtifactBindingStatus,
    sourceArtifactIds,
    sourceKinds,
  }
}

const rowReview = (
  value: unknown,
  path: string,
): PublicTaxReportV2RowReview => {
  const row = record(value, path, ['status', 'limitations'])
  const status = oneOf(row.status, `${path}.status`, [
    'CLEAR', 'REVIEW_REQUIRED',
  ])
  const limitations = array(row.limitations, `${path}.limitations`, limitation)
  if (
    (status === 'CLEAR' && limitations.length !== 0) ||
    (status === 'REVIEW_REQUIRED' && limitations.length === 0)
  ) {
    invalid(path, 'review status and limitations disagree')
  }
  return { status, limitations }
}

const assetSummary = (
  value: unknown,
  path: string,
  taxYear: number,
): PublicTaxReportV2AssetSummary => {
  const row = record(value, path, [
    'taxAssetId', 'openingQuantity', 'openingBasis',
    'openingBasisProvenance', 'acquiredQuantity',
    'acquisitionCost', 'annualAverage', 'disposedQuantity', 'grossProceeds',
    'incurredExpense', 'deductibleExpense', 'disposedBasis', 'gainLoss',
    'endingQuantity', 'endingCost', 'basisMode',
  ], ['basisEvidenceDigest'])
  const { mode, evidence } = basisDecision(
    row.basisMode,
    row.basisEvidenceDigest,
    path,
  )
  const openingQuantity = numeric(
    row.openingQuantity,
    `${path}.openingQuantity`,
    true,
  )
  const provenanceRow = record(
    row.openingBasisProvenance,
    `${path}.openingBasisProvenance`,
    ['status'],
    [
      'basisRule', 'actualAcquisitionAmount', 'marketValueAt2026End',
      'sourceRunId',
    ],
  )
  const openingBasisProvenance = {
    status: oneOf(
      provenanceRow.status,
      `${path}.openingBasisProvenance.status`,
      ['NOT_APPLICABLE', 'UNKNOWN', 'KNOWN'],
    ),
    basisRule: optionalString(
      provenanceRow.basisRule,
      `${path}.openingBasisProvenance.basisRule`,
    ),
    actualAcquisitionAmount: provenanceRow.actualAcquisitionAmount === undefined
      ? null
      : numeric(
        provenanceRow.actualAcquisitionAmount,
        `${path}.openingBasisProvenance.actualAcquisitionAmount`,
        true,
      ),
    marketValueAt2026End: provenanceRow.marketValueAt2026End === undefined
      ? null
      : numeric(
        provenanceRow.marketValueAt2026End,
        `${path}.openingBasisProvenance.marketValueAt2026End`,
        true,
      ),
    sourceRunId: optionalString(
      provenanceRow.sourceRunId,
      `${path}.openingBasisProvenance.sourceRunId`,
    ),
  } as PublicTaxReportV2AssetSummary['openingBasisProvenance']
  if (
    openingBasisProvenance.status === 'NOT_APPLICABLE' &&
    Object.entries(openingBasisProvenance).some(
      ([key, entry]) => key !== 'status' && entry !== null,
    )
  ) {
    invalid(`${path}.openingBasisProvenance`, 'NOT_APPLICABLE must not carry values')
  }
  if (
    (openingQuantity === '0') !==
    (openingBasisProvenance.status === 'NOT_APPLICABLE')
  ) {
    invalid(
      `${path}.openingBasisProvenance`,
      'must be NOT_APPLICABLE exactly when opening quantity is zero',
    )
  }
  if (openingBasisProvenance.status === 'KNOWN') {
    const knownRule =
      (openingBasisProvenance.basisRule === 'ACTUAL_ACQUISITION' &&
        openingBasisProvenance.actualAcquisitionAmount !== null) ||
      (openingBasisProvenance.basisRule === 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET' &&
        openingBasisProvenance.actualAcquisitionAmount !== null &&
        openingBasisProvenance.marketValueAt2026End !== null) ||
      (openingBasisProvenance.basisRule === 'PRIOR_FINAL_RUN' &&
        openingBasisProvenance.sourceRunId !== null)
    if (!knownRule) {
      invalid(
        `${path}.openingBasisProvenance`,
        'KNOWN provenance is missing the evidence required by its basis rule',
      )
    }
    const expectedRule = taxYear < 2027
      ? 'ACTUAL_ACQUISITION'
      : taxYear === 2027
        ? 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET'
        : 'PRIOR_FINAL_RUN'
    if (openingBasisProvenance.basisRule !== expectedRule) {
      invalid(
        `${path}.openingBasisProvenance.basisRule`,
        `must be ${expectedRule} for tax year ${taxYear}`,
      )
    }
  }
  const openingBasis = amount(row.openingBasis, `${path}.openingBasis`)
  if (
    openingQuantity === '0' &&
    (openingBasis.status !== 'KNOWN' || openingBasis.amount !== '0')
  ) {
    invalid(
      `${path}.openingBasis`,
      'zero opening quantity must carry a known zero opening basis',
    )
  }
  if (openingBasisProvenance.status === 'KNOWN' && openingBasis.status === 'KNOWN') {
    let expectedBasis: bigint | null = null
    if (openingBasisProvenance.basisRule === 'ACTUAL_ACQUISITION') {
      expectedBasis = BigInt(openingBasisProvenance.actualAcquisitionAmount!)
    } else if (
      openingBasisProvenance.basisRule === 'PRE_EFFECTIVE_MAX_ACTUAL_MARKET'
    ) {
      const actual = BigInt(openingBasisProvenance.actualAcquisitionAmount!)
      const market = BigInt(openingBasisProvenance.marketValueAt2026End!)
      expectedBasis = actual > market ? actual : market
    }
    if (expectedBasis !== null && BigInt(openingBasis.amount) !== expectedBasis) {
      invalid(
        `${path}.openingBasis`,
        'does not match the canonical opening-basis transition evidence',
      )
    }
  }
  const annualAverage = average(row.annualAverage, `${path}.annualAverage`)
  if (
    (mode === 'DEEMED_EXPENSE_50') !==
    (annualAverage.status === 'NOT_APPLICABLE')
  ) {
    invalid(
      `${path}.annualAverage`,
      'must be NOT_APPLICABLE exactly for the 50% deemed-expense mode',
    )
  }
  return {
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    openingQuantity,
    openingBasis,
    openingBasisProvenance,
    acquiredQuantity: numeric(row.acquiredQuantity, `${path}.acquiredQuantity`, true),
    acquisitionCost: amount(row.acquisitionCost, `${path}.acquisitionCost`),
    annualAverage,
    disposedQuantity: numeric(row.disposedQuantity, `${path}.disposedQuantity`, true),
    grossProceeds: amount(row.grossProceeds, `${path}.grossProceeds`),
    incurredExpense: amount(row.incurredExpense, `${path}.incurredExpense`),
    deductibleExpense: amount(row.deductibleExpense, `${path}.deductibleExpense`),
    disposedBasis: amount(row.disposedBasis, `${path}.disposedBasis`),
    gainLoss: amount(row.gainLoss, `${path}.gainLoss`),
    endingQuantity: numeric(row.endingQuantity, `${path}.endingQuantity`, true),
    endingCost: amount(row.endingCost, `${path}.endingCost`),
    basisMode: mode,
    basisEvidenceDigest: evidence,
  }
}

const disposal = (value: unknown, path: string) => {
  const row = record(value, path, [
    'transactionType', 'movementId', 'eventId', 'revisionId', 'legId', 'taxAddressId',
    'taxAssetId', 'ledgerAssetId', 'quantity', 'grossProceeds',
    'ancillaryExpense', 'basis', 'gainLoss', 'costMethod',
    'incurredExpense', 'basisMode', 'occurredAt', 'account', 'valuation',
    'sourceEvidence', 'review',
  ], ['valuationId', 'rounding', 'relatedMovementId', 'basisEvidenceDigest'])
  const { mode, evidence } = basisDecision(
    row.basisMode,
    row.basisEvidenceDigest,
    path,
  )
  const parsedValuation = valuationPair(row, path)
  const costMethod = oneOf(
    row.costMethod,
    `${path}.costMethod`,
    ['ANNUAL_TOTAL_AVERAGE'],
  )
  const rounding = oneOf(
    row.rounding,
    `${path}.rounding`,
    mode === 'ACTUAL_TOTAL_AVERAGE'
      ? ['CUMULATIVE_FLOOR_ANNUAL_POOL']
      : ['CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS'],
  )
  return {
    transactionType: oneOf(
      row.transactionType,
      `${path}.transactionType`,
      ['DISPOSAL', 'FEE_ASSET_DISPOSAL'],
    ),
    movementId: string(row.movementId, `${path}.movementId`),
    relatedMovementId: optionalString(row.relatedMovementId, `${path}.relatedMovementId`),
    eventId: string(row.eventId, `${path}.eventId`),
    revisionId: string(row.revisionId, `${path}.revisionId`),
    legId: string(row.legId, `${path}.legId`),
    taxAddressId: string(row.taxAddressId, `${path}.taxAddressId`),
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    ledgerAssetId: string(row.ledgerAssetId, `${path}.ledgerAssetId`),
    quantity: numeric(row.quantity, `${path}.quantity`, true),
    grossProceeds: amount(row.grossProceeds, `${path}.grossProceeds`),
    ancillaryExpense: amount(row.ancillaryExpense, `${path}.ancillaryExpense`),
    incurredExpense: amount(row.incurredExpense, `${path}.incurredExpense`),
    basis: amount(row.basis, `${path}.basis`),
    gainLoss: amount(row.gainLoss, `${path}.gainLoss`),
    valuationId: parsedValuation.valuationId,
    costMethod,
    rounding,
    basisMode: mode,
    basisEvidenceDigest: evidence,
    occurredAt: timestamp(row.occurredAt, `${path}.occurredAt`),
    account: account(row.account, `${path}.account`),
    valuation: parsedValuation.valuation,
    sourceEvidence: array(
      row.sourceEvidence,
      `${path}.sourceEvidence`,
      sourceEvidence,
    ),
    review: rowReview(row.review, `${path}.review`),
  }
}

const movementBase = (row: JsonRecord, path: string): PublicMovementBase => {
  const parsedValuation = valuationPair(row, path)
  return {
    transactionType: string(row.transactionType, `${path}.transactionType`),
    movementId: string(row.movementId, `${path}.movementId`),
    relatedMovementId: optionalString(row.relatedMovementId, `${path}.relatedMovementId`),
    eventId: string(row.eventId, `${path}.eventId`),
    revisionId: string(row.revisionId, `${path}.revisionId`),
    legId: string(row.legId, `${path}.legId`),
    kind: string(row.kind, `${path}.kind`),
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    ledgerAssetId: string(row.ledgerAssetId, `${path}.ledgerAssetId`),
    quantity: numeric(row.quantity, `${path}.quantity`, true),
    valuationId: parsedValuation.valuationId,
    occurredAt: timestamp(row.occurredAt, `${path}.occurredAt`),
    account: account(row.account, `${path}.account`),
    valuation: parsedValuation.valuation,
    sourceEvidence: array(
      row.sourceEvidence,
      `${path}.sourceEvidence`,
      sourceEvidence,
    ),
    review: rowReview(row.review, `${path}.review`),
  }
}

const acquisition = (value: unknown, path: string) => {
  const row = record(value, path, [
    'transactionType', 'movementId', 'eventId', 'revisionId', 'legId', 'kind',
    'taxAssetId', 'ledgerAssetId', 'quantity', 'consideration',
    'acquisitionAncillaryExpense', 'acquisitionCost', 'occurredAt',
    'account', 'valuation', 'sourceEvidence', 'review',
  ], ['relatedMovementId', 'valuationId'])
  const result = {
    ...movementBase(row, path),
    consideration: amount(row.consideration, `${path}.consideration`),
    acquisitionAncillaryExpense: amount(
      row.acquisitionAncillaryExpense,
      `${path}.acquisitionAncillaryExpense`,
    ),
    acquisitionCost: amount(row.acquisitionCost, `${path}.acquisitionCost`),
  }
  const kind = oneOf(result.kind, `${path}.kind`, [
    'ACQUIRE', 'OTHER_ACQUISITION',
  ])
  const transactionType = oneOf(
    result.transactionType,
    `${path}.transactionType`,
    ['ACQUIRE', 'OTHER_ACQUISITION'],
  )
  if (
    result.consideration.status === 'KNOWN' &&
    result.acquisitionAncillaryExpense.status === 'KNOWN' &&
    result.acquisitionCost.status === 'KNOWN' &&
    BigInt(result.consideration.amount) +
      BigInt(result.acquisitionAncillaryExpense.amount) !==
      BigInt(result.acquisitionCost.amount)
  ) {
    invalid(path, 'consideration plus acquisition ancillary expense must equal acquisition cost')
  }
  if (transactionType !== kind) {
    invalid(`${path}.transactionType`, 'must equal acquisition kind')
  }
  return { ...result, transactionType, kind }
}

const income = (value: unknown, path: string) => {
  const row = record(value, path, [
    'transactionType', 'movementId', 'eventId', 'revisionId', 'legId', 'kind',
    'taxAssetId', 'ledgerAssetId', 'quantity', 'income', 'ancillaryExpense',
    'occurredAt', 'account', 'valuation', 'sourceEvidence', 'review',
  ], ['relatedMovementId', 'valuationId'])
  const result = {
    ...movementBase(row, path),
    income: amount(row.income, `${path}.income`),
    ancillaryExpense: amount(row.ancillaryExpense, `${path}.ancillaryExpense`),
  }
  const kind = oneOf(result.kind, `${path}.kind`, [
    'LENDING_INCOME_CASH', 'LENDING_INCOME_ASSET',
  ])
  const transactionType = oneOf(
    result.transactionType,
    `${path}.transactionType`,
    ['LENDING_INCOME_CASH', 'LENDING_INCOME_ASSET'],
  )
  if (transactionType !== kind) {
    invalid(`${path}.transactionType`, 'must equal income kind')
  }
  return { ...result, transactionType, kind }
}

const transfer = (value: unknown, path: string) => {
  const row = record(value, path, [
    'transactionType', 'movementId', 'eventId', 'revisionId', 'fromLegId', 'toLegId',
    'fromAddressId', 'toAddressId', 'taxAssetId', 'quantity', 'basis',
    'fromCostMethod', 'toCostMethod', 'occurredAt', 'from', 'to',
    'sourceEvidence', 'review',
  ])
  return {
    transactionType: oneOf(row.transactionType, `${path}.transactionType`, ['TRANSFER']),
    movementId: string(row.movementId, `${path}.movementId`),
    eventId: string(row.eventId, `${path}.eventId`),
    revisionId: string(row.revisionId, `${path}.revisionId`),
    fromLegId: string(row.fromLegId, `${path}.fromLegId`),
    toLegId: string(row.toLegId, `${path}.toLegId`),
    fromAddressId: string(row.fromAddressId, `${path}.fromAddressId`),
    toAddressId: string(row.toAddressId, `${path}.toAddressId`),
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    quantity: numeric(row.quantity, `${path}.quantity`, true),
    basis: amount(row.basis, `${path}.basis`),
    fromCostMethod: string(row.fromCostMethod, `${path}.fromCostMethod`),
    toCostMethod: string(row.toCostMethod, `${path}.toCostMethod`),
    occurredAt: timestamp(row.occurredAt, `${path}.occurredAt`),
    from: account(row.from, `${path}.from`),
    to: account(row.to, `${path}.to`),
    sourceEvidence: array(row.sourceEvidence, `${path}.sourceEvidence`, sourceEvidence),
    review: rowReview(row.review, `${path}.review`),
  }
}

const excluded = (value: unknown, path: string) => {
  const row = record(value, path, [
    'eventId', 'revisionId', 'relationId', 'taxAddressId', 'taxAssetId',
    'fromLegId', 'toLegId', 'fromQuantity', 'toQuantity',
  ])
  return {
    eventId: string(row.eventId, `${path}.eventId`),
    revisionId: string(row.revisionId, `${path}.revisionId`),
    relationId: string(row.relationId, `${path}.relationId`),
    taxAddressId: string(row.taxAddressId, `${path}.taxAddressId`),
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    fromLegId: string(row.fromLegId, `${path}.fromLegId`),
    toLegId: string(row.toLegId, `${path}.toLegId`),
    fromQuantity: numeric(row.fromQuantity, `${path}.fromQuantity`, true),
    toQuantity: numeric(row.toQuantity, `${path}.toQuantity`, true),
  }
}

const nonTaxableTransfer = (value: unknown, path: string) => {
  const row = record(value, path, [
    'transactionType', 'movementId', 'eventId', 'revisionId', 'fromLegId',
    'toLegId', 'taxAssetId', 'quantity', 'occurredAt', 'from', 'to',
    'sourceEvidence', 'review',
  ])
  return {
    transactionType: oneOf(
      row.transactionType,
      `${path}.transactionType`,
      ['SELF_TRANSFER'],
    ),
    movementId: string(row.movementId, `${path}.movementId`),
    eventId: string(row.eventId, `${path}.eventId`),
    revisionId: string(row.revisionId, `${path}.revisionId`),
    fromLegId: string(row.fromLegId, `${path}.fromLegId`),
    toLegId: string(row.toLegId, `${path}.toLegId`),
    taxAssetId: string(row.taxAssetId, `${path}.taxAssetId`),
    quantity: numeric(row.quantity, `${path}.quantity`, true),
    occurredAt: timestamp(row.occurredAt, `${path}.occurredAt`),
    from: account(row.from, `${path}.from`),
    to: account(row.to, `${path}.to`),
    sourceEvidence: array(row.sourceEvidence, `${path}.sourceEvidence`, sourceEvidence),
    review: rowReview(row.review, `${path}.review`),
  }
}

const limitation = (value: unknown, path: string) => {
  const row = record(value, path, ['code', 'reason'], [
    'taxAddressId', 'taxAssetId', 'movementId', 'reviewId', 'reviewRevisionId',
  ])
  const reviewId = optionalString(row.reviewId, `${path}.reviewId`)
  const reviewRevisionId = optionalString(row.reviewRevisionId, `${path}.reviewRevisionId`)
  if ((reviewId === null) !== (reviewRevisionId === null)) {
    invalid(path, 'review identifiers must be present together')
  }
  return {
    code: string(row.code, `${path}.code`),
    reason: string(row.reason, `${path}.reason`),
    taxAddressId: optionalString(row.taxAddressId, `${path}.taxAddressId`),
    taxAssetId: optionalString(row.taxAssetId, `${path}.taxAssetId`),
    movementId: optionalString(row.movementId, `${path}.movementId`),
    reviewId,
    reviewRevisionId,
  }
}

const sourceCoverage = (value: unknown, path: string): PublicTaxReportV2SourceCoverage => {
  const row = record(value, path, [
    'sourceArtifactId', 'sourceKind', 'assurance', 'status', 'evidenceDigest',
    'fragmentIds', 'coveredIntervals', 'uncoveredIntervals',
  ], ['systemName'])
  return {
    sourceArtifactId: string(row.sourceArtifactId, `${path}.sourceArtifactId`),
    sourceKind: string(row.sourceKind, `${path}.sourceKind`),
    systemName: optionalString(row.systemName, `${path}.systemName`),
    assurance: oneOf(row.assurance, `${path}.assurance`, [
      'UNKNOWN', 'USER_DECLARED', 'DOCUMENT_METADATA_VERIFIED', 'CHAIN_VERIFIED',
    ]),
    status: oneOf(row.status, `${path}.status`, ['UNKNOWN', 'PARTIAL', 'COMPLETE']),
    evidenceDigest: digest(row.evidenceDigest, `${path}.evidenceDigest`),
    fragmentIds: stringArray(row.fragmentIds, `${path}.fragmentIds`),
    coveredIntervals: array(row.coveredIntervals, `${path}.coveredIntervals`, interval),
    uncoveredIntervals: array(row.uncoveredIntervals, `${path}.uncoveredIntervals`, interval),
  }
}

const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (!isRecord(value)) invalid('$', 'contains a non-JSON value')
  const object = value as JsonRecord
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(object[key])}`).join(',')}}`
}

export const decodeAndProjectTaxReportModelV2 = (
  artifact: TaxReportModelArtifact,
  expectedReportId: string,
): PublicTaxReportV2Detail => {
  if (!REPORT_ID.test(expectedReportId)) invalid('expectedReportId', 'is invalid')
  if (artifact.reportId !== expectedReportId) invalid('artifact.reportId', 'does not match')
  if (artifact.mediaType !== TAX_REPORT_MODEL_V2_MEDIA_TYPE) {
    invalid('artifact.mediaType', 'is not ReportModel V2')
  }
  if (!(artifact.canonicalJson instanceof Uint8Array) ||
      artifact.canonicalJson.byteLength === 0 ||
      artifact.canonicalJson.byteLength > MAX_BYTES) {
    invalid('artifact.canonicalJson', 'has an invalid byte length')
  }
  const artifactDigest = digest(artifact.artifactDigest, 'artifact.artifactDigest')
  if (createHash('sha256').update(artifact.canonicalJson).digest('hex') !== artifactDigest) {
    invalid('artifact.artifactDigest', 'does not match canonicalJson')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(artifact.canonicalJson)
  } catch {
    return invalid('artifact.canonicalJson', 'must be UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid('artifact.canonicalJson', 'must be JSON')
  }
  if (canonicalStringify(parsed) !== text) {
    invalid('artifact.canonicalJson', 'must be exact canonical JSON')
  }
  const root = record(parsed, '$', [
    'schemaVersion', 'reportId', 'inputDigest', 'subjectId', 'residentId',
    'taxYear', 'status', 'calculationStatus', 'taxOutcome', 'filingAction',
    'filingStatus', 'filingSubmissionStatus', 'inputPeriod', 'dataCoverage', 'calculatedAsOf',
    'taxYearCloseStatus', 'valuationFinality', 'reportFinality',
    'taxInventoryRunId', 'taxEstimateId', 'lotRunId',
    'sourceLedgerGenerationId',
    'schemaDigest', 'denominationAssetId', 'denominationAtomicDecimals',
    'evidencePackDigest', 'counts',
    'summary', 'assetSummaries', 'disposals', 'feeAssetDisposals',
    'acquisitions', 'incomeRows', 'transfers', 'excludedConversions',
    'nonTaxableTransfers', 'limitations', 'sourceCoverage', 'policy',
    'engine', 'issuedAt',
  ])
  if (root.schemaVersion !== REPORT_SCHEMA_V2) invalid('$.schemaVersion', 'is not V2')
  if (root.reportId !== expectedReportId) invalid('$.reportId', 'does not match')
  // Ownership is checked upstream and these identifiers are deliberately omitted
  // from the browser projection.
  string(root.subjectId, '$.subjectId')
  string(root.residentId, '$.residentId')
  const taxYear = integer(root.taxYear, '$.taxYear')
  if (taxYear < 2025) invalid('$.taxYear', 'is unsupported')

  const countsRow = record(root.counts, '$.counts', [
    'assetSummaries', 'disposals', 'feeAssetDisposals', 'acquisitions',
    'incomeRows', 'transfers', 'nonTaxableTransfers', 'limitations',
    'sourceArtifacts',
  ])
  const counts = {
    assetSummaries: integer(countsRow.assetSummaries, '$.counts.assetSummaries'),
    disposals: integer(countsRow.disposals, '$.counts.disposals'),
    feeAssetDisposals: integer(countsRow.feeAssetDisposals, '$.counts.feeAssetDisposals'),
    acquisitions: integer(countsRow.acquisitions, '$.counts.acquisitions'),
    incomeRows: integer(countsRow.incomeRows, '$.counts.incomeRows'),
    transfers: integer(countsRow.transfers, '$.counts.transfers'),
    nonTaxableTransfers: integer(
      countsRow.nonTaxableTransfers,
      '$.counts.nonTaxableTransfers',
    ),
    limitations: integer(countsRow.limitations, '$.counts.limitations'),
    sourceArtifacts: integer(countsRow.sourceArtifacts, '$.counts.sourceArtifacts'),
  }
  const summaryRow = record(root.summary, '$.summary', [
    'grossProceeds', 'disposedBasis', 'deductibleExpense', 'incurredExpense',
    'disposalGainLoss', 'lendingIncome', 'lendingExpense',
    'netLendingIncome', 'taxableIncome', 'taxableBase', 'nationalTax',
    'localTax', 'totalTax', 'calculationRule',
  ])
  const coverageRow = record(root.dataCoverage, '$.dataCoverage', [
    'status', 'assurance', 'from', 'through', 'coveredIntervals',
    'uncoveredIntervals',
  ], ['declaration'])
  const assetSummaries = array(
    root.assetSummaries,
    '$.assetSummaries',
    (row, path) => assetSummary(row, path, taxYear),
  )
  const disposals = array(root.disposals, '$.disposals', disposal)
  const feeAssetDisposals = array(root.feeAssetDisposals, '$.feeAssetDisposals', disposal)
  const acquisitions = array(root.acquisitions, '$.acquisitions', acquisition)
  const incomeRows = array(root.incomeRows, '$.incomeRows', income)
  const transfers = array(root.transfers, '$.transfers', transfer)
  const limitations = array(root.limitations, '$.limitations', limitation)
  const nonTaxableTransfers = array(
    root.nonTaxableTransfers,
    '$.nonTaxableTransfers',
    nonTaxableTransfer,
  )
  const sources = array(root.sourceCoverage, '$.sourceCoverage', sourceCoverage)
  if (
    counts.assetSummaries !== assetSummaries.length ||
    counts.disposals !== disposals.length ||
    counts.feeAssetDisposals !== feeAssetDisposals.length ||
    counts.acquisitions !== acquisitions.length ||
    counts.incomeRows !== incomeRows.length ||
    counts.transfers !== transfers.length ||
    counts.nonTaxableTransfers !== nonTaxableTransfers.length ||
    counts.limitations !== limitations.length ||
    counts.sourceArtifacts !== sources.length
  ) invalid('$.counts', 'does not match materialized arrays')
  if (disposals.some((row) => row.transactionType !== 'DISPOSAL')) {
    invalid('$.disposals', 'must contain only DISPOSAL rows')
  }
  if (feeAssetDisposals.some(
    (row) => row.transactionType !== 'FEE_ASSET_DISPOSAL',
  )) {
    invalid('$.feeAssetDisposals', 'must contain only FEE_ASSET_DISPOSAL rows')
  }
  const assetDecisionById = new Map<
    string,
    Pick<PublicTaxReportV2AssetSummary, 'basisMode' | 'basisEvidenceDigest'>
  >()
  for (const [index, summary] of assetSummaries.entries()) {
    if (assetDecisionById.has(summary.taxAssetId)) {
      invalid(
        `$.assetSummaries[${index}].taxAssetId`,
        'must be unique within the resident annual pool',
      )
    }
    if (taxYear < 2027 && summary.basisMode === 'DEEMED_EXPENSE_50') {
      invalid(
        `$.assetSummaries[${index}].basisMode`,
        '50% deemed-expense mode is unavailable before tax year 2027',
      )
    }
    assetDecisionById.set(summary.taxAssetId, summary)
  }
  for (const [collection, rows] of [
    ['disposals', disposals],
    ['feeAssetDisposals', feeAssetDisposals],
  ] as const) {
    for (const [index, row] of rows.entries()) {
      const summary = assetDecisionById.get(row.taxAssetId) ?? invalid(
          `$.${collection}[${index}].taxAssetId`,
          'must have exactly one matching asset-year basis decision',
        )
      if (
        summary.basisMode !== row.basisMode ||
        summary.basisEvidenceDigest !== row.basisEvidenceDigest
      ) {
        invalid(
          `$.${collection}[${index}].basisMode`,
          'must match the asset-year basis decision exactly',
        )
      }
      if (taxYear < 2027 && row.basisMode === 'DEEMED_EXPENSE_50') {
        invalid(
          `$.${collection}[${index}].basisMode`,
          '50% deemed-expense mode is unavailable before tax year 2027',
        )
      }
    }
  }
  const filingAction = oneOf(root.filingAction, '$.filingAction', [
    'BLOCKED', 'REVIEW_REQUIRED', 'FILING_ACTION_REQUIRED', 'FILING_NOT_APPLICABLE',
  ])
  const filingStatus = oneOf(root.filingStatus, '$.filingStatus', ['READY', 'BLOCKED'])
  if (
    (filingAction === 'FILING_ACTION_REQUIRED') !==
    (filingStatus === 'READY')
  ) {
    invalid('$.filingStatus', 'must agree with the canonical filing action')
  }
  const denominationAtomicDecimals = integer(
    root.denominationAtomicDecimals,
    '$.denominationAtomicDecimals',
  )
  if (denominationAtomicDecimals < 1 || denominationAtomicDecimals > 18) {
    invalid('$.denominationAtomicDecimals', 'must be between 1 and 18')
  }
  const parsedPolicy = policy(root.policy, '$.policy')
  if (parsedPolicy.denominationAtomicDecimals !== denominationAtomicDecimals) {
    invalid(
      '$.denominationAtomicDecimals',
      'must equal the exact policy denomination scale',
    )
  }
  const filingSubmissionStatus = oneOf(
    root.filingSubmissionStatus,
    '$.filingSubmissionStatus',
    ['UNKNOWN', 'NOT_APPLICABLE'],
  )
  if (
    (parsedPolicy.applicationMode === 'ENACTED' &&
      filingSubmissionStatus !== 'UNKNOWN') ||
    (parsedPolicy.applicationMode === 'SIMULATION' &&
      filingSubmissionStatus !== 'NOT_APPLICABLE')
  ) {
    invalid(
      '$.filingSubmissionStatus',
      'must match the report policy application mode',
    )
  }

  return {
    schemaVersion: REPORT_SCHEMA_V2,
    reportId: expectedReportId,
    reportModelDigest: artifactDigest,
    inputDigest: digest(root.inputDigest, '$.inputDigest'),
    evidencePackDigest: digest(root.evidencePackDigest, '$.evidencePackDigest'),
    taxYear,
    status: oneOf(root.status, '$.status', ['FINAL', 'PARTIAL']),
    calculationStatus: oneOf(root.calculationStatus, '$.calculationStatus', ['COMPLETE', 'BLOCKED']),
    taxOutcome: oneOf(root.taxOutcome, '$.taxOutcome', [
      'INCOMPLETE', 'NO_TAX_EVENTS', 'TAX_ZERO', 'ESTIMATED_TAX_ZERO',
      'ESTIMATED_TAX_DUE',
      'TAX_DUE', 'SIMULATED_TAX_ZERO', 'SIMULATED_TAX_DUE',
    ]),
    filingAction,
    filingStatus,
    filingSubmissionStatus,
    inputPeriod: interval(root.inputPeriod, '$.inputPeriod'),
    dataCoverage: {
      status: oneOf(coverageRow.status, '$.dataCoverage.status', ['UNKNOWN', 'PARTIAL', 'COMPLETE']),
      assurance: oneOf(coverageRow.assurance, '$.dataCoverage.assurance', [
        'UNKNOWN', 'USER_DECLARED', 'DOCUMENT_METADATA_VERIFIED', 'CHAIN_VERIFIED',
      ]),
      from: timestamp(coverageRow.from, '$.dataCoverage.from'),
      through: timestamp(coverageRow.through, '$.dataCoverage.through'),
      declaration: optionalString(coverageRow.declaration, '$.dataCoverage.declaration'),
      coveredIntervals: array(coverageRow.coveredIntervals, '$.dataCoverage.coveredIntervals', interval),
      uncoveredIntervals: array(coverageRow.uncoveredIntervals, '$.dataCoverage.uncoveredIntervals', interval),
    },
    calculatedAsOf: timestamp(root.calculatedAsOf, '$.calculatedAsOf'),
    taxYearCloseStatus: oneOf(root.taxYearCloseStatus, '$.taxYearCloseStatus', ['OPEN', 'CLOSED']),
    valuationFinality: oneOf(root.valuationFinality, '$.valuationFinality', ['FINAL', 'PROVISIONAL']),
    reportFinality: oneOf(root.reportFinality, '$.reportFinality', ['FINAL', 'PROVISIONAL']),
    denominationAssetId: string(root.denominationAssetId, '$.denominationAssetId'),
    denominationAtomicDecimals,
    counts,
    summary: {
      grossProceeds: amount(summaryRow.grossProceeds, '$.summary.grossProceeds'),
      disposedBasis: amount(summaryRow.disposedBasis, '$.summary.disposedBasis'),
      deductibleExpense: amount(
        summaryRow.deductibleExpense,
        '$.summary.deductibleExpense',
      ),
      incurredExpense: amount(
        summaryRow.incurredExpense,
        '$.summary.incurredExpense',
      ),
      disposalGainLoss: amount(summaryRow.disposalGainLoss, '$.summary.disposalGainLoss'),
      lendingIncome: amount(summaryRow.lendingIncome, '$.summary.lendingIncome'),
      lendingExpense: amount(summaryRow.lendingExpense, '$.summary.lendingExpense'),
      netLendingIncome: amount(summaryRow.netLendingIncome, '$.summary.netLendingIncome'),
      taxableIncome: amount(summaryRow.taxableIncome, '$.summary.taxableIncome'),
      taxableBase: amount(summaryRow.taxableBase, '$.summary.taxableBase'),
      nationalTax: amount(summaryRow.nationalTax, '$.summary.nationalTax'),
      localTax: amount(summaryRow.localTax, '$.summary.localTax'),
      totalTax: amount(summaryRow.totalTax, '$.summary.totalTax'),
      calculationRule: calculationRule(summaryRow.calculationRule, '$.summary.calculationRule'),
    },
    assetSummaries,
    disposals,
    feeAssetDisposals,
    acquisitions,
    incomeRows,
    transfers,
    nonTaxableTransfers,
    excludedConversions: array(root.excludedConversions, '$.excludedConversions', excluded),
    limitations,
    sourceCoverage: sources,
    methodology: {
      taxInventoryRunId: string(root.taxInventoryRunId, '$.taxInventoryRunId'),
      taxEstimateId: string(root.taxEstimateId, '$.taxEstimateId'),
      lotRunId: string(root.lotRunId, '$.lotRunId'),
      sourceLedgerGenerationId: string(
        root.sourceLedgerGenerationId,
        '$.sourceLedgerGenerationId',
      ),
      schemaDigest: digest(root.schemaDigest, '$.schemaDigest'),
      policy: parsedPolicy,
      engine: producer(root.engine, '$.engine'),
    },
    issuedAt: timestamp(root.issuedAt, '$.issuedAt'),
  }
}

const publicStringSchema = { type: 'string' } as const
const publicDigestSchema = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
} as const
const publicNullableStringSchema = {
  anyOf: [publicStringSchema, { type: 'null' }],
} as const

export const publicTaxReportV2AmountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'amount', 'hasAmount'],
  properties: {
    status: { type: 'string', enum: ['KNOWN', 'UNKNOWN'] },
    amount: publicNullableStringSchema,
    hasAmount: { type: 'boolean' },
  },
} as const

export const publicTaxReportV2IntervalSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'through'],
  properties: {
    from: publicStringSchema,
    through: publicStringSchema,
  },
} as const

export const publicTaxReportV2PolicySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'name', 'version', 'artifactDigest', 'sourceSetDigest', 'applicationMode',
    'effectiveFrom', 'effectiveThrough', 'denominationAtomicDecimals',
    'roundingProfileStatus',
    'roundingProfileEvidenceDigest', 'legalReferences',
  ],
  properties: {
    name: publicStringSchema,
    version: publicStringSchema,
    artifactDigest: publicDigestSchema,
    sourceSetDigest: publicDigestSchema,
    applicationMode: { type: 'string', enum: ['ENACTED', 'SIMULATION'] },
    effectiveFrom: publicStringSchema,
    effectiveThrough: publicStringSchema,
    denominationAtomicDecimals: {
      type: 'integer',
      minimum: 1,
      maximum: 18,
    },
    roundingProfileStatus: {
      type: 'string',
      enum: ['APPROVED', 'ESTIMATE_ONLY_UNAPPROVED'],
    },
    roundingProfileEvidenceDigest: publicNullableStringSchema,
    legalReferences: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'law', 'article', 'paragraphs', 'purpose', 'sourceLocators',
          'sourceCheckedAt',
        ],
        properties: {
          law: publicStringSchema,
          article: publicStringSchema,
          paragraphs: { type: 'array', items: publicStringSchema },
          purpose: publicStringSchema,
          sourceLocators: { type: 'array', items: publicStringSchema },
          sourceCheckedAt: publicNullableStringSchema,
        },
      },
    },
  },
} as const

export const publicTaxReportV2SourceCoverageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'sourceArtifactId', 'sourceKind', 'assurance', 'status', 'evidenceDigest',
    'systemName', 'fragmentIds', 'coveredIntervals', 'uncoveredIntervals',
  ],
  properties: {
    sourceArtifactId: publicStringSchema,
    sourceKind: publicStringSchema,
    systemName: publicNullableStringSchema,
    assurance: {
      type: 'string',
      enum: [
        'UNKNOWN', 'USER_DECLARED', 'DOCUMENT_METADATA_VERIFIED',
        'CHAIN_VERIFIED',
      ],
    },
    status: { type: 'string', enum: ['UNKNOWN', 'PARTIAL', 'COMPLETE'] },
    evidenceDigest: publicDigestSchema,
    fragmentIds: { type: 'array', items: publicStringSchema },
    coveredIntervals: {
      type: 'array',
      items: publicTaxReportV2IntervalSchema,
    },
    uncoveredIntervals: {
      type: 'array',
      items: publicTaxReportV2IntervalSchema,
    },
  },
} as const

export const publicTaxReportV2MethodologySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taxInventoryRunId', 'taxEstimateId', 'lotRunId',
    'sourceLedgerGenerationId',
    'schemaDigest', 'policy', 'engine',
  ],
  properties: {
    taxInventoryRunId: publicStringSchema,
    taxEstimateId: publicStringSchema,
    lotRunId: publicStringSchema,
    sourceLedgerGenerationId: publicStringSchema,
    schemaDigest: publicDigestSchema,
    policy: publicTaxReportV2PolicySchema,
    engine: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version', 'artifactDigest'],
      properties: {
        name: publicStringSchema,
        version: publicStringSchema,
        artifactDigest: publicDigestSchema,
      },
    },
  },
} as const

const publicAnnualAverageSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status', 'numerator', 'denominator', 'unitCost', 'unitCostNumerator',
    'unitCostDenominator', 'rounding',
  ],
  properties: {
    status: {
      type: 'string',
      enum: ['KNOWN', 'UNKNOWN', 'NOT_APPLICABLE'],
    },
    numerator: publicNullableStringSchema,
    denominator: publicNullableStringSchema,
    unitCost: publicNullableStringSchema,
    unitCostNumerator: publicNullableStringSchema,
    unitCostDenominator: publicNullableStringSchema,
    rounding: publicNullableStringSchema,
  },
} as const

const publicLimitationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'code', 'reason', 'taxAddressId', 'taxAssetId', 'movementId',
    'reviewId', 'reviewRevisionId',
  ],
  properties: {
    code: publicStringSchema,
    reason: publicStringSchema,
    taxAddressId: publicNullableStringSchema,
    taxAssetId: publicNullableStringSchema,
    movementId: publicNullableStringSchema,
    reviewId: publicNullableStringSchema,
    reviewRevisionId: publicNullableStringSchema,
  },
} as const

const publicAccountSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status', 'accountId', 'accountKind', 'displayNameStatus', 'displayName',
  ],
  properties: {
    status: { type: 'string', enum: ['UNKNOWN', 'PARTIAL', 'KNOWN'] },
    accountId: publicNullableStringSchema,
    accountKind: publicNullableStringSchema,
    displayNameStatus: { type: 'string', const: 'UNKNOWN' },
    displayName: publicNullableStringSchema,
  },
} as const

const publicValuationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'status', 'valuationId', 'kind', 'effectiveAt', 'quoteId',
    'snapshotArtifactDigest', 'baseAtomicUnits', 'quoteAtomicUnits',
    'rounding', 'providerStatus', 'provider', 'datasetVersionStatus',
    'datasetVersion', 'marketStatus', 'market',
  ],
  properties: {
    status: { type: 'string', enum: ['UNKNOWN', 'PARTIAL', 'KNOWN'] },
    valuationId: publicNullableStringSchema,
    kind: publicNullableStringSchema,
    effectiveAt: publicNullableStringSchema,
    quoteId: publicNullableStringSchema,
    snapshotArtifactDigest: {
      anyOf: [publicDigestSchema, { type: 'null' }],
    },
    baseAtomicUnits: publicNullableStringSchema,
    quoteAtomicUnits: publicNullableStringSchema,
    rounding: publicNullableStringSchema,
    providerStatus: { type: 'string', enum: ['UNKNOWN', 'KNOWN'] },
    provider: publicNullableStringSchema,
    datasetVersionStatus: { type: 'string', enum: ['UNKNOWN', 'KNOWN'] },
    datasetVersion: publicNullableStringSchema,
    marketStatus: {
      type: 'string',
      enum: ['UNKNOWN', 'KNOWN', 'NOT_APPLICABLE'],
    },
    market: publicNullableStringSchema,
  },
} as const

const publicSourceEvidenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'legId', 'relationId', 'fragmentId', 'observationId',
    'sourceArtifactBindingStatus', 'sourceArtifactIds', 'sourceKinds',
  ],
  properties: {
    legId: publicNullableStringSchema,
    relationId: publicNullableStringSchema,
    fragmentId: publicStringSchema,
    observationId: publicStringSchema,
    sourceArtifactBindingStatus: {
      type: 'string',
      enum: ['BOUND', 'UNBOUND'],
    },
    sourceArtifactIds: { type: 'array', items: publicStringSchema },
    sourceKinds: { type: 'array', items: publicStringSchema },
  },
} as const

const publicRowReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'limitations'],
  properties: {
    status: { type: 'string', enum: ['CLEAR', 'REVIEW_REQUIRED'] },
    limitations: { type: 'array', items: publicLimitationSchema },
  },
} as const

const publicAssetSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'taxAssetId', 'openingQuantity', 'openingBasis',
    'openingBasisProvenance', 'acquiredQuantity',
    'acquisitionCost', 'annualAverage', 'disposedQuantity', 'grossProceeds',
    'incurredExpense', 'deductibleExpense', 'disposedBasis', 'gainLoss',
    'endingQuantity', 'endingCost', 'basisMode', 'basisEvidenceDigest',
  ],
  properties: {
    taxAssetId: publicStringSchema,
    openingQuantity: publicStringSchema,
    openingBasis: publicTaxReportV2AmountSchema,
    openingBasisProvenance: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status', 'basisRule', 'actualAcquisitionAmount',
        'marketValueAt2026End', 'sourceRunId',
      ],
      properties: {
        status: {
          type: 'string',
          enum: ['NOT_APPLICABLE', 'UNKNOWN', 'KNOWN'],
        },
        basisRule: publicNullableStringSchema,
        actualAcquisitionAmount: publicNullableStringSchema,
        marketValueAt2026End: publicNullableStringSchema,
        sourceRunId: publicNullableStringSchema,
      },
    },
    acquiredQuantity: publicStringSchema,
    acquisitionCost: publicTaxReportV2AmountSchema,
    annualAverage: publicAnnualAverageSchema,
    disposedQuantity: publicStringSchema,
    grossProceeds: publicTaxReportV2AmountSchema,
    incurredExpense: publicTaxReportV2AmountSchema,
    deductibleExpense: publicTaxReportV2AmountSchema,
    disposedBasis: publicTaxReportV2AmountSchema,
    gainLoss: publicTaxReportV2AmountSchema,
    endingQuantity: publicStringSchema,
    endingCost: publicTaxReportV2AmountSchema,
    basisMode: {
      type: 'string',
      enum: ['ACTUAL_TOTAL_AVERAGE', 'DEEMED_EXPENSE_50'],
    },
    basisEvidenceDigest: {
      anyOf: [publicDigestSchema, { type: 'null' }],
    },
  },
} as const

const publicDisposalSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'transactionType', 'movementId', 'relatedMovementId', 'eventId', 'revisionId', 'legId',
    'taxAddressId', 'taxAssetId', 'ledgerAssetId', 'quantity',
    'grossProceeds', 'ancillaryExpense', 'incurredExpense', 'basis',
    'gainLoss', 'valuationId', 'costMethod', 'rounding', 'basisMode',
    'basisEvidenceDigest', 'occurredAt', 'account', 'valuation',
    'sourceEvidence', 'review',
  ],
  properties: {
    transactionType: {
      type: 'string',
      enum: ['DISPOSAL', 'FEE_ASSET_DISPOSAL'],
    },
    movementId: publicStringSchema,
    relatedMovementId: publicNullableStringSchema,
    eventId: publicStringSchema,
    revisionId: publicStringSchema,
    legId: publicStringSchema,
    taxAddressId: publicStringSchema,
    taxAssetId: publicStringSchema,
    ledgerAssetId: publicStringSchema,
    quantity: publicStringSchema,
    grossProceeds: publicTaxReportV2AmountSchema,
    ancillaryExpense: publicTaxReportV2AmountSchema,
    incurredExpense: publicTaxReportV2AmountSchema,
    basis: publicTaxReportV2AmountSchema,
    gainLoss: publicTaxReportV2AmountSchema,
    valuationId: publicNullableStringSchema,
    costMethod: { type: 'string', const: 'ANNUAL_TOTAL_AVERAGE' },
    rounding: {
      type: 'string',
      enum: [
        'CUMULATIVE_FLOOR_ANNUAL_POOL',
        'CUMULATIVE_FLOOR_50_PERCENT_PROCEEDS',
      ],
    },
    basisMode: {
      type: 'string',
      enum: ['ACTUAL_TOTAL_AVERAGE', 'DEEMED_EXPENSE_50'],
    },
    basisEvidenceDigest: {
      anyOf: [publicDigestSchema, { type: 'null' }],
    },
    occurredAt: publicStringSchema,
    account: publicAccountSchema,
    valuation: publicValuationSchema,
    sourceEvidence: { type: 'array', items: publicSourceEvidenceSchema },
    review: publicRowReviewSchema,
  },
} as const

const publicMovementProperties = {
  transactionType: publicStringSchema,
  movementId: publicStringSchema,
  relatedMovementId: publicNullableStringSchema,
  eventId: publicStringSchema,
  revisionId: publicStringSchema,
  legId: publicStringSchema,
  kind: publicStringSchema,
  taxAssetId: publicStringSchema,
  ledgerAssetId: publicStringSchema,
  quantity: publicStringSchema,
  valuationId: publicNullableStringSchema,
  occurredAt: publicStringSchema,
  account: publicAccountSchema,
  valuation: publicValuationSchema,
  sourceEvidence: { type: 'array', items: publicSourceEvidenceSchema },
  review: publicRowReviewSchema,
} as const

const publicMovementRequired = [
  'transactionType', 'movementId', 'relatedMovementId', 'eventId',
  'revisionId', 'legId', 'kind', 'taxAssetId', 'ledgerAssetId', 'quantity',
  'valuationId', 'occurredAt', 'account', 'valuation', 'sourceEvidence',
  'review',
] as const

const publicCalculationRuleSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'poolScope', 'costMethods', 'basicDeductionAmount', 'deductionUsedAmount',
    'nationalRate', 'localRate', 'taxRounding', 'basisAllocationRounding',
  ],
  properties: {
    poolScope: { type: 'string', const: 'RESIDENT_TAX_YEAR_TAX_ASSET' },
    costMethods: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: { type: 'string', const: 'ANNUAL_TOTAL_AVERAGE' },
    },
    basicDeductionAmount: publicStringSchema,
    deductionUsedAmount: publicNullableStringSchema,
    nationalRate: {
      type: 'object',
      additionalProperties: false,
      required: ['numerator', 'denominator'],
      properties: {
        numerator: publicStringSchema,
        denominator: publicStringSchema,
      },
    },
    localRate: {
      type: 'object',
      additionalProperties: false,
      required: ['numerator', 'denominator'],
      properties: {
        numerator: publicStringSchema,
        denominator: publicStringSchema,
      },
    },
    taxRounding: { type: 'string', const: 'FLOOR' },
    basisAllocationRounding: {
      type: 'string',
      const: 'CUMULATIVE_FLOOR_ANNUAL_POOL',
    },
  },
} as const

const publicSummaryProperties = {
  grossProceeds: publicTaxReportV2AmountSchema,
  disposedBasis: publicTaxReportV2AmountSchema,
  deductibleExpense: publicTaxReportV2AmountSchema,
  incurredExpense: publicTaxReportV2AmountSchema,
  disposalGainLoss: publicTaxReportV2AmountSchema,
  lendingIncome: publicTaxReportV2AmountSchema,
  lendingExpense: publicTaxReportV2AmountSchema,
  netLendingIncome: publicTaxReportV2AmountSchema,
  taxableIncome: publicTaxReportV2AmountSchema,
  taxableBase: publicTaxReportV2AmountSchema,
  nationalTax: publicTaxReportV2AmountSchema,
  localTax: publicTaxReportV2AmountSchema,
  totalTax: publicTaxReportV2AmountSchema,
  calculationRule: publicCalculationRuleSchema,
} as const

export const publicTaxReportV2DetailSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'reportId', 'reportModelDigest', 'inputDigest',
    'evidencePackDigest', 'taxYear', 'status', 'calculationStatus',
    'taxOutcome', 'filingAction', 'filingStatus', 'filingSubmissionStatus', 'inputPeriod',
    'dataCoverage', 'calculatedAsOf', 'taxYearCloseStatus',
    'valuationFinality', 'reportFinality', 'denominationAssetId',
    'denominationAtomicDecimals', 'counts',
    'summary', 'assetSummaries', 'disposals', 'feeAssetDisposals',
    'acquisitions', 'incomeRows', 'transfers', 'excludedConversions',
    'nonTaxableTransfers', 'limitations', 'sourceCoverage', 'methodology',
    'issuedAt',
  ],
  properties: {
    schemaVersion: { type: 'string', const: REPORT_SCHEMA_V2 },
    reportId: { type: 'string', pattern: '^tax-report-v2:[0-9a-f]{64}$' },
    reportModelDigest: publicDigestSchema,
    inputDigest: publicDigestSchema,
    evidencePackDigest: publicDigestSchema,
    taxYear: { type: 'integer', minimum: 2025 },
    status: { type: 'string', enum: ['FINAL', 'PARTIAL'] },
    calculationStatus: { type: 'string', enum: ['COMPLETE', 'BLOCKED'] },
    taxOutcome: {
      type: 'string',
      enum: [
        'INCOMPLETE', 'NO_TAX_EVENTS', 'TAX_ZERO', 'ESTIMATED_TAX_ZERO',
        'ESTIMATED_TAX_DUE',
        'TAX_DUE', 'SIMULATED_TAX_ZERO', 'SIMULATED_TAX_DUE',
      ],
    },
    filingAction: {
      type: 'string',
      enum: [
        'BLOCKED', 'REVIEW_REQUIRED', 'FILING_ACTION_REQUIRED',
        'FILING_NOT_APPLICABLE',
      ],
    },
    filingStatus: { type: 'string', enum: ['READY', 'BLOCKED'] },
    filingSubmissionStatus: {
      type: 'string',
      enum: ['UNKNOWN', 'NOT_APPLICABLE'],
    },
    inputPeriod: publicTaxReportV2IntervalSchema,
    dataCoverage: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status', 'assurance', 'from', 'through', 'declaration',
        'coveredIntervals', 'uncoveredIntervals',
      ],
      properties: {
        status: { type: 'string', enum: ['UNKNOWN', 'PARTIAL', 'COMPLETE'] },
        assurance: {
          type: 'string',
          enum: [
            'UNKNOWN', 'USER_DECLARED', 'DOCUMENT_METADATA_VERIFIED',
            'CHAIN_VERIFIED',
          ],
        },
        from: publicStringSchema,
        through: publicStringSchema,
        declaration: publicNullableStringSchema,
        coveredIntervals: {
          type: 'array',
          items: publicTaxReportV2IntervalSchema,
        },
        uncoveredIntervals: {
          type: 'array',
          items: publicTaxReportV2IntervalSchema,
        },
      },
    },
    calculatedAsOf: publicStringSchema,
    taxYearCloseStatus: { type: 'string', enum: ['OPEN', 'CLOSED'] },
    valuationFinality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    reportFinality: { type: 'string', enum: ['FINAL', 'PROVISIONAL'] },
    denominationAssetId: publicStringSchema,
    denominationAtomicDecimals: {
      type: 'integer',
      minimum: 1,
      maximum: 18,
    },
    counts: {
      type: 'object',
      additionalProperties: false,
      required: [
        'assetSummaries', 'disposals', 'feeAssetDisposals', 'acquisitions',
        'incomeRows', 'transfers', 'nonTaxableTransfers', 'limitations',
        'sourceArtifacts',
      ],
      properties: {
        assetSummaries: { type: 'integer', minimum: 0 },
        disposals: { type: 'integer', minimum: 0 },
        feeAssetDisposals: { type: 'integer', minimum: 0 },
        acquisitions: { type: 'integer', minimum: 0 },
        incomeRows: { type: 'integer', minimum: 0 },
        transfers: { type: 'integer', minimum: 0 },
        nonTaxableTransfers: { type: 'integer', minimum: 0 },
        limitations: { type: 'integer', minimum: 0 },
        sourceArtifacts: { type: 'integer', minimum: 0 },
      },
    },
    summary: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(publicSummaryProperties),
      properties: publicSummaryProperties,
    },
    assetSummaries: { type: 'array', items: publicAssetSummarySchema },
    disposals: { type: 'array', items: publicDisposalSchema },
    feeAssetDisposals: { type: 'array', items: publicDisposalSchema },
    acquisitions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          ...publicMovementRequired,
          'consideration',
          'acquisitionAncillaryExpense',
          'acquisitionCost',
        ],
        properties: {
          ...publicMovementProperties,
          transactionType: {
            type: 'string',
            enum: ['ACQUIRE', 'OTHER_ACQUISITION'],
          },
          kind: {
            type: 'string',
            enum: ['ACQUIRE', 'OTHER_ACQUISITION'],
          },
          consideration: publicTaxReportV2AmountSchema,
          acquisitionAncillaryExpense: publicTaxReportV2AmountSchema,
          acquisitionCost: publicTaxReportV2AmountSchema,
        },
      },
    },
    incomeRows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [...publicMovementRequired, 'income', 'ancillaryExpense'],
        properties: {
          ...publicMovementProperties,
          transactionType: {
            type: 'string',
            enum: ['LENDING_INCOME_CASH', 'LENDING_INCOME_ASSET'],
          },
          kind: {
            type: 'string',
            enum: ['LENDING_INCOME_CASH', 'LENDING_INCOME_ASSET'],
          },
          income: publicTaxReportV2AmountSchema,
          ancillaryExpense: publicTaxReportV2AmountSchema,
        },
      },
    },
    transfers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transactionType', 'movementId', 'eventId', 'revisionId',
          'fromLegId', 'toLegId',
          'fromAddressId', 'toAddressId', 'taxAssetId', 'quantity', 'basis',
          'fromCostMethod', 'toCostMethod', 'occurredAt', 'from', 'to',
          'sourceEvidence', 'review',
        ],
        properties: {
          transactionType: { type: 'string', const: 'TRANSFER' },
          movementId: publicStringSchema,
          eventId: publicStringSchema,
          revisionId: publicStringSchema,
          fromLegId: publicStringSchema,
          toLegId: publicStringSchema,
          fromAddressId: publicStringSchema,
          toAddressId: publicStringSchema,
          taxAssetId: publicStringSchema,
          quantity: publicStringSchema,
          basis: publicTaxReportV2AmountSchema,
          fromCostMethod: publicStringSchema,
          toCostMethod: publicStringSchema,
          occurredAt: publicStringSchema,
          from: publicAccountSchema,
          to: publicAccountSchema,
          sourceEvidence: {
            type: 'array',
            items: publicSourceEvidenceSchema,
          },
          review: publicRowReviewSchema,
        },
      },
    },
    nonTaxableTransfers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'transactionType', 'movementId', 'eventId', 'revisionId',
          'fromLegId', 'toLegId', 'taxAssetId', 'quantity', 'occurredAt',
          'from', 'to', 'sourceEvidence', 'review',
        ],
        properties: {
          transactionType: { type: 'string', const: 'SELF_TRANSFER' },
          movementId: publicStringSchema,
          eventId: publicStringSchema,
          revisionId: publicStringSchema,
          fromLegId: publicStringSchema,
          toLegId: publicStringSchema,
          taxAssetId: publicStringSchema,
          quantity: publicStringSchema,
          occurredAt: publicStringSchema,
          from: publicAccountSchema,
          to: publicAccountSchema,
          sourceEvidence: {
            type: 'array',
            items: publicSourceEvidenceSchema,
          },
          review: publicRowReviewSchema,
        },
      },
    },
    excludedConversions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'eventId', 'revisionId', 'relationId', 'taxAddressId', 'taxAssetId',
          'fromLegId', 'toLegId', 'fromQuantity', 'toQuantity',
        ],
        properties: {
          eventId: publicStringSchema,
          revisionId: publicStringSchema,
          relationId: publicStringSchema,
          taxAddressId: publicStringSchema,
          taxAssetId: publicStringSchema,
          fromLegId: publicStringSchema,
          toLegId: publicStringSchema,
          fromQuantity: publicStringSchema,
          toQuantity: publicStringSchema,
        },
      },
    },
    limitations: {
      type: 'array',
      items: publicLimitationSchema,
    },
    sourceCoverage: {
      type: 'array',
      items: publicTaxReportV2SourceCoverageSchema,
    },
    methodology: publicTaxReportV2MethodologySchema,
    issuedAt: publicStringSchema,
  },
} as const
