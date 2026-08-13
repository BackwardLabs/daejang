import { createHash } from 'node:crypto'
import { TextDecoder } from 'node:util'

import {
  TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
  TAX_EVIDENCE_PACK_V2_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
} from './model-reader.js'
import {
  decodeAndProjectTaxEvidencePackV2,
  type PublicTaxEvidencePackV2,
} from './evidence-pack-v2.js'

const EVIDENCE_SCHEMA_V1 = 'giwa.tax-evidence-pack.v1'
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const REPORT_ID_PATTERN = /^tax-report:[0-9a-f]{64}$/
const MANIFEST_ID_PATTERN = /^tax-evidence-pack:[0-9a-f]{64}$/
const RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
const MAX_CANONICAL_JSON_BYTES = 16 * 1024 * 1024
const MAX_EVIDENCE_ROWS = 250_000

type JsonRecord = Record<string, unknown>

export type PublicTaxEvidencePack = {
  schemaVersion: typeof EVIDENCE_SCHEMA_V1
  reportId: string
  artifactDigest: string
  manifestId: string
  taxYear: number
  artifactRoots: Array<{
    kind: string
    digest: string
  }>
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
  methodology: {
    taxInventoryRunId: string
    taxEstimateId: string
    lotRunId: string
    generationId: string
    schemaDigest: string
    policy: PublicEvidenceProducer
    engine: PublicEvidenceProducer
  }
  issuedAt: string
}

type PublicEvidenceProducer = {
  name: string
  version: string
  artifactDigest: string
}

export class InvalidTaxEvidencePackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTaxEvidencePackError'
  }
}

const invalid = (path: string, message: string): never => {
  throw new InvalidTaxEvidencePackError(`${path}: ${message}`)
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const exactRecord = (
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  if (!isRecord(value)) return invalid(path, 'must be an object')
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not allowed')
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid(`${path}.${key}`, 'is required')
  }
  return value
}

const requiredString = (record: JsonRecord, key: string, path: string) => {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(`${path}.${key}`, 'must be a non-empty string')
  }
  return value
}

const optionalString = (record: JsonRecord, key: string, path: string) =>
  Object.hasOwn(record, key) ? requiredString(record, key, path) : null

const digestString = (record: JsonRecord, key: string, path: string) => {
  const value = requiredString(record, key, path)
  if (!DIGEST_PATTERN.test(value)) {
    return invalid(`${path}.${key}`, 'must be a lowercase SHA-256 digest')
  }
  return value
}

const parseProducer = (value: unknown, path: string): PublicEvidenceProducer => {
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
  parseRow: (row: unknown, rowPath: string) => T,
) => {
  if (!Array.isArray(value)) return invalid(path, 'must be an array')
  if (value.length > MAX_EVIDENCE_ROWS) {
    return invalid(path, `must contain at most ${MAX_EVIDENCE_ROWS} rows`)
  }
  return value.map((row, index) => parseRow(row, `${path}[${index}]`))
}

const parseArtifactRoot = (value: unknown, path: string) => {
  const record = exactRecord(value, path, ['kind', 'digest'])
  return {
    kind: requiredString(record, 'kind', path),
    digest: digestString(record, 'digest', path),
  }
}

const coordinateKeys = [
  'eventId',
  'revisionId',
  'legId',
  'relationId',
  'valuationId',
  'movementId',
  'reviewId',
  'reviewRevisionId',
  'fragmentId',
  'observationId',
  'generationId',
  'schemaDigest',
] as const

const parseEvidenceCoordinate = (value: unknown, path: string) => {
  const record = exactRecord(value, path, ['kind'], coordinateKeys)
  const parsed = Object.fromEntries(
    coordinateKeys.map((key) => [key, optionalString(record, key, path)]),
  ) as Record<(typeof coordinateKeys)[number], string | null>
  if (parsed.schemaDigest !== null && !DIGEST_PATTERN.test(parsed.schemaDigest)) {
    invalid(`${path}.schemaDigest`, 'must be a lowercase SHA-256 digest')
  }
  return {
    kind: requiredString(record, 'kind', path),
    eventId: parsed.eventId,
    revisionId: parsed.revisionId,
    legId: parsed.legId,
    relationId: parsed.relationId,
    valuationId: parsed.valuationId,
    movementId: parsed.movementId,
    reviewId: parsed.reviewId,
    reviewRevisionId: parsed.reviewRevisionId,
    fragmentId: parsed.fragmentId,
    observationId: parsed.observationId,
    generationId: parsed.generationId,
    schemaDigest: parsed.schemaDigest,
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

export const decodeAndProjectTaxEvidencePack = (
  artifact: TaxEvidencePackArtifact,
  expectedReportId: string,
): PublicTaxEvidencePack | PublicTaxEvidencePackV2 => {
  if (artifact.mediaType === TAX_EVIDENCE_PACK_V2_MEDIA_TYPE) {
    return decodeAndProjectTaxEvidencePackV2(artifact, expectedReportId)
  }
  if (!REPORT_ID_PATTERN.test(expectedReportId)) {
    return invalid('$.reportId', 'requested report ID is invalid')
  }
  if (artifact.reportId !== expectedReportId) {
    return invalid('artifact.reportId', 'does not match the requested report')
  }
  if (artifact.mediaType !== TAX_EVIDENCE_PACK_V1_MEDIA_TYPE) {
    return invalid('artifact.mediaType', 'is not a supported evidence pack')
  }
  if (!(artifact.canonicalJson instanceof Uint8Array)) {
    return invalid('artifact.canonicalJson', 'must be bytes')
  }
  if (
    artifact.canonicalJson.byteLength === 0 ||
    artifact.canonicalJson.byteLength > MAX_CANONICAL_JSON_BYTES
  ) {
    return invalid(
      'artifact.canonicalJson',
      `must contain between 1 and ${MAX_CANONICAL_JSON_BYTES} bytes`,
    )
  }
  if (!DIGEST_PATTERN.test(artifact.artifactDigest)) {
    return invalid('artifact.artifactDigest', 'must be a lowercase SHA-256 digest')
  }
  const actualDigest = createHash('sha256')
    .update(artifact.canonicalJson)
    .digest('hex')
  if (actualDigest !== artifact.artifactDigest) {
    return invalid('artifact.artifactDigest', 'does not match the evidence bytes')
  }

  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(
      artifact.canonicalJson,
    )
  } catch {
    return invalid('artifact.canonicalJson', 'must be valid UTF-8')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return invalid('artifact.canonicalJson', 'must be valid JSON')
  }
  if (canonicalStringify(parsed) !== decoded) {
    return invalid(
      'artifact.canonicalJson',
      'must be exact RFC 8785 canonical JSON',
    )
  }

  const record = exactRecord(parsed, '$', [
    'schemaVersion',
    'manifestId',
    'reportId',
    'subjectId',
    'residentId',
    'taxYear',
    'taxInventoryRunId',
    'taxEstimateId',
    'lotRunId',
    'generationId',
    'schemaDigest',
    'artifactRoots',
    'evidenceCoordinates',
    'policy',
    'engine',
    'issuedAt',
  ])
  const schemaVersion = requiredString(record, 'schemaVersion', '$')
  if (schemaVersion !== EVIDENCE_SCHEMA_V1) {
    invalid('$.schemaVersion', `must equal ${EVIDENCE_SCHEMA_V1}`)
  }
  const reportId = requiredString(record, 'reportId', '$')
  if (reportId !== expectedReportId) {
    invalid('$.reportId', 'does not match the requested report')
  }
  // These private identifiers are required for Engine-side ownership binding,
  // but are deliberately not copied to the browser projection.
  requiredString(record, 'subjectId', '$')
  requiredString(record, 'residentId', '$')
  const taxYear = record.taxYear
  if (typeof taxYear !== 'number') {
    return invalid('$.taxYear', 'must be a supported integer tax year')
  }
  if (!Number.isSafeInteger(taxYear) || taxYear < 2025 || taxYear > 9999) {
    return invalid('$.taxYear', 'must be a supported integer tax year')
  }
  const issuedAt = requiredString(record, 'issuedAt', '$')
  if (
    !RFC3339_UTC_PATTERN.test(issuedAt) ||
    !Number.isFinite(Date.parse(issuedAt))
  ) {
    invalid('$.issuedAt', 'must be an RFC 3339 UTC timestamp')
  }
  const manifestId = requiredString(record, 'manifestId', '$')
  if (!MANIFEST_ID_PATTERN.test(manifestId)) {
    invalid(
      '$.manifestId',
      'must be a canonical tax evidence pack manifest ID',
    )
  }

  return {
    schemaVersion: EVIDENCE_SCHEMA_V1,
    reportId,
    artifactDigest: artifact.artifactDigest,
    manifestId,
    taxYear,
    artifactRoots: parseArray(
      record.artifactRoots,
      '$.artifactRoots',
      parseArtifactRoot,
    ),
    evidenceCoordinates: parseArray(
      record.evidenceCoordinates,
      '$.evidenceCoordinates',
      parseEvidenceCoordinate,
    ),
    methodology: {
      taxInventoryRunId: requiredString(record, 'taxInventoryRunId', '$'),
      taxEstimateId: requiredString(record, 'taxEstimateId', '$'),
      lotRunId: requiredString(record, 'lotRunId', '$'),
      generationId: requiredString(record, 'generationId', '$'),
      schemaDigest: digestString(record, 'schemaDigest', '$'),
      policy: parseProducer(record.policy, '$.policy'),
      engine: parseProducer(record.engine, '$.engine'),
    },
    issuedAt,
  }
}

const nullableStringSchema = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const

export const publicTaxEvidencePackSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'reportId',
    'artifactDigest',
    'manifestId',
    'taxYear',
    'artifactRoots',
    'evidenceCoordinates',
    'methodology',
    'issuedAt',
  ],
  properties: {
    schemaVersion: { type: 'string', const: EVIDENCE_SCHEMA_V1 },
    reportId: { type: 'string' },
    artifactDigest: { type: 'string' },
    manifestId: { type: 'string' },
    taxYear: { type: 'integer' },
    artifactRoots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'digest'],
        properties: {
          kind: { type: 'string' },
          digest: { type: 'string' },
        },
      },
    },
    evidenceCoordinates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', ...coordinateKeys],
        properties: {
          kind: { type: 'string' },
          ...Object.fromEntries(
            coordinateKeys.map((key) => [key, nullableStringSchema]),
          ),
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
        schemaDigest: { type: 'string' },
        policy: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'version', 'artifactDigest'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            artifactDigest: { type: 'string' },
          },
        },
        engine: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'version', 'artifactDigest'],
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            artifactDigest: { type: 'string' },
          },
        },
      },
    },
    issuedAt: { type: 'string' },
  },
} as const
