import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

import {
  TAX_EVIDENCE_PACK_V2_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
} from './model-reader.js'
import type {
  PublicTaxReportV2Policy,
  PublicTaxReportV2SourceCoverage,
} from './public-model-v2.js'
import {
  publicTaxReportV2MethodologySchema,
  publicTaxReportV2SourceCoverageSchema,
} from './public-model-v2.js'

export const EVIDENCE_SCHEMA_V2 = 'giwa.tax-evidence-pack.v2' as const

const DIGEST = /^[0-9a-f]{64}$/
const REPORT_ID = /^tax-report-v2:[0-9a-f]{64}$/
const MANIFEST_ID = /^tax-evidence-pack-v2:[0-9a-f]{64}$/
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 250_000

type JsonRecord = Record<string, unknown>

export type PublicTaxEvidencePackV2 = {
  schemaVersion: typeof EVIDENCE_SCHEMA_V2
  reportId: string
  artifactDigest: string
  manifestId: string
  taxYear: number
  artifactRoots: Array<{ kind: string; digest: string }>
  evidenceCoordinates: Array<{
    kind: string
    eventId: string | null
    revisionId: string | null
    legId: string | null
    relationId: string | null
    valuationId: string | null
    movementId: string | null
    reviewId: string | null
    reviewRevisionId: string | null
    fragmentId: string | null
    observationId: string | null
    generationId: string | null
    schemaDigest: string | null
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

export class InvalidTaxEvidencePackV2Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaxEvidencePackV2Error'
  }
}

const invalid = (path: string, message: string): never => {
  throw new InvalidTaxEvidencePackV2Error(`${path}: ${message}`)
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
  const parsed = value as JsonRecord
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not allowed')
  }
  for (const key of required) {
    if (!Object.hasOwn(parsed, key)) invalid(`${path}.${key}`, 'is required')
  }
  return parsed
}

const string = (value: unknown, path: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    invalid(path, 'must be a non-empty string')
  }
  return value as string
}

const optionalString = (value: unknown, path: string): string | null =>
  value === undefined ? null : string(value, path)

const digest = (value: unknown, path: string) => {
  const parsed = string(value, path)
  if (!DIGEST.test(parsed)) invalid(path, 'must be a lowercase SHA-256 digest')
  return parsed
}

const timestamp = (value: unknown, path: string) => {
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

const oneOf = <T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
) => {
  const parsed = string(value, path)
  if (!values.includes(parsed as T)) invalid(path, 'has an unsupported value')
  return parsed as T
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
  const result = array(value, path, string)
  if (new Set(result).size !== result.length) invalid(path, 'must be unique')
  return result
}

const interval = (value: unknown, path: string) => {
  const row = record(value, path, ['from', 'through'])
  const from = timestamp(row.from, `${path}.from`)
  const through = timestamp(row.through, `${path}.through`)
  if (Date.parse(through) < Date.parse(from)) invalid(path, 'is reversed')
  return { from, through }
}

const sourceCoverage = (
  value: unknown,
  path: string,
): PublicTaxReportV2SourceCoverage => {
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
      const ref = record(
        value,
        legalPath,
        ['law', 'article', 'purpose'],
        ['paragraphs', 'sourceLocators', 'sourceCheckedAt'],
      )
      const sourceLocators = ref.sourceLocators === undefined
        ? []
        : array(ref.sourceLocators, `${legalPath}.sourceLocators`, legalSourceLocator)
      if (new Set(sourceLocators).size !== sourceLocators.length) {
        invalid(`${legalPath}.sourceLocators`, 'must be unique')
      }
      return {
        law: string(ref.law, `${legalPath}.law`),
        article: string(ref.article, `${legalPath}.article`),
        paragraphs: ref.paragraphs === undefined
          ? []
          : stringArray(ref.paragraphs, `${legalPath}.paragraphs`),
        purpose: string(ref.purpose, `${legalPath}.purpose`),
        sourceLocators,
        sourceCheckedAt: ref.sourceCheckedAt === undefined
          ? null
          : timestamp(ref.sourceCheckedAt, `${legalPath}.sourceCheckedAt`),
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
  if (
    !Number.isSafeInteger(row.denominationAtomicDecimals) ||
    Number(row.denominationAtomicDecimals) < 1 ||
    Number(row.denominationAtomicDecimals) > 18
  ) {
    invalid(`${path}.denominationAtomicDecimals`, 'must be between 1 and 18')
  }
  return {
    name: string(row.name, `${path}.name`),
    version: string(row.version, `${path}.version`),
    artifactDigest: digest(row.artifactDigest, `${path}.artifactDigest`),
    sourceSetDigest: digest(row.sourceSetDigest, `${path}.sourceSetDigest`),
    applicationMode: oneOf(row.applicationMode, `${path}.applicationMode`, ['ENACTED', 'SIMULATION']),
    effectiveFrom: timestamp(row.effectiveFrom, `${path}.effectiveFrom`),
    effectiveThrough: timestamp(row.effectiveThrough, `${path}.effectiveThrough`),
    denominationAtomicDecimals: Number(row.denominationAtomicDecimals),
    roundingProfileStatus,
    roundingProfileEvidenceDigest,
    legalReferences,
  }
}

const coordinateKeys = [
  'eventId', 'revisionId', 'legId', 'relationId', 'valuationId',
  'movementId', 'reviewId', 'reviewRevisionId', 'fragmentId',
  'observationId', 'generationId', 'schemaDigest',
] as const

const coordinate = (value: unknown, path: string) => {
  const row = record(value, path, ['kind'], coordinateKeys)
  const result = Object.fromEntries(coordinateKeys.map((key) => [
    key,
    optionalString(row[key], `${path}.${key}`),
  ])) as Record<(typeof coordinateKeys)[number], string | null>
  if (result.schemaDigest !== null && !DIGEST.test(result.schemaDigest)) {
    invalid(`${path}.schemaDigest`, 'must be a digest')
  }
  return { kind: string(row.kind, `${path}.kind`), ...result }
}

const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' ||
      typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  if (!isRecord(value)) invalid('$', 'contains a non-JSON value')
  const object = value as JsonRecord
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(object[key])}`).join(',')}}`
}

export const decodeAndProjectTaxEvidencePackV2 = (
  artifact: TaxEvidencePackArtifact,
  expectedReportId: string,
): PublicTaxEvidencePackV2 => {
  if (!REPORT_ID.test(expectedReportId)) invalid('expectedReportId', 'is invalid')
  if (artifact.reportId !== expectedReportId) invalid('artifact.reportId', 'does not match')
  if (artifact.mediaType !== TAX_EVIDENCE_PACK_V2_MEDIA_TYPE) {
    invalid('artifact.mediaType', 'is not EvidencePack V2')
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
    'schemaVersion', 'manifestId', 'reportId', 'subjectId', 'residentId',
    'taxYear', 'taxInventoryRunId', 'taxEstimateId', 'lotRunId',
    'sourceLedgerGenerationId', 'schemaDigest', 'artifactRoots',
    'evidenceCoordinates',
    'sourceCoverage', 'policy', 'engine', 'issuedAt',
  ])
  if (root.schemaVersion !== EVIDENCE_SCHEMA_V2) invalid('$.schemaVersion', 'is not V2')
  if (root.reportId !== expectedReportId) invalid('$.reportId', 'does not match')
  string(root.subjectId, '$.subjectId')
  string(root.residentId, '$.residentId')
  const manifestId = string(root.manifestId, '$.manifestId')
  if (!MANIFEST_ID.test(manifestId)) invalid('$.manifestId', 'is invalid')
  if (!Number.isSafeInteger(root.taxYear) || Number(root.taxYear) < 2025) {
    invalid('$.taxYear', 'is unsupported')
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_V2,
    reportId: expectedReportId,
    artifactDigest,
    manifestId,
    taxYear: root.taxYear as number,
    artifactRoots: array(root.artifactRoots, '$.artifactRoots', (value, path) => {
      const row = record(value, path, ['kind', 'digest'])
      return { kind: string(row.kind, `${path}.kind`), digest: digest(row.digest, `${path}.digest`) }
    }),
    evidenceCoordinates: array(root.evidenceCoordinates, '$.evidenceCoordinates', coordinate),
    sourceCoverage: array(root.sourceCoverage, '$.sourceCoverage', sourceCoverage),
    methodology: {
      taxInventoryRunId: string(root.taxInventoryRunId, '$.taxInventoryRunId'),
      taxEstimateId: string(root.taxEstimateId, '$.taxEstimateId'),
      lotRunId: string(root.lotRunId, '$.lotRunId'),
      sourceLedgerGenerationId: string(
        root.sourceLedgerGenerationId,
        '$.sourceLedgerGenerationId',
      ),
      schemaDigest: digest(root.schemaDigest, '$.schemaDigest'),
      policy: policy(root.policy, '$.policy'),
      engine: producer(root.engine, '$.engine'),
    },
    issuedAt: timestamp(root.issuedAt, '$.issuedAt'),
  }
}

export const publicTaxEvidencePackV2Schema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion', 'reportId', 'artifactDigest', 'manifestId', 'taxYear',
    'artifactRoots', 'evidenceCoordinates', 'sourceCoverage', 'methodology',
    'issuedAt',
  ],
  properties: {
    schemaVersion: { type: 'string', const: EVIDENCE_SCHEMA_V2 },
    reportId: { type: 'string', pattern: '^tax-report-v2:[0-9a-f]{64}$' },
    artifactDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    manifestId: {
      type: 'string',
      pattern: '^tax-evidence-pack-v2:[0-9a-f]{64}$',
    },
    taxYear: { type: 'integer', minimum: 2025 },
    artifactRoots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'digest'],
        properties: {
          kind: { type: 'string' },
          digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
    evidenceCoordinates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind', 'eventId', 'revisionId', 'legId', 'relationId',
          'valuationId', 'movementId', 'reviewId', 'reviewRevisionId',
          'fragmentId', 'observationId', 'generationId', 'schemaDigest',
        ],
        properties: {
          kind: { type: 'string' },
          eventId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          revisionId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          legId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          relationId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          valuationId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          movementId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          reviewId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          reviewRevisionId: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
          },
          fragmentId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          observationId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          generationId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          schemaDigest: {
            anyOf: [
              { type: 'string', pattern: '^[0-9a-f]{64}$' },
              { type: 'null' },
            ],
          },
        },
      },
    },
    sourceCoverage: {
      type: 'array',
      items: publicTaxReportV2SourceCoverageSchema,
    },
    methodology: publicTaxReportV2MethodologySchema,
    issuedAt: { type: 'string' },
  },
} as const
