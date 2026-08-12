import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  decodeAndProjectTaxEvidencePackV2,
  InvalidTaxEvidencePackV2Error,
  publicTaxEvidencePackV2Schema,
} from './evidence-pack-v2.js'
import {
  TAX_EVIDENCE_PACK_V2_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
} from './model-reader.js'

const reportId = `tax-report-v2:${'a'.repeat(64)}`
const digest = (character: string) => character.repeat(64)

const canonicalStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const row = value as Record<string, unknown>
  return `{${Object.keys(row).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalStringify(row[key])}`).join(',')}}`
}

const evidenceFixture = () => ({
  schemaVersion: 'giwa.tax-evidence-pack.v2',
  manifestId: `tax-evidence-pack-v2:${'b'.repeat(64)}`,
  reportId,
  subjectId: 'private-subject',
  residentId: 'private-resident',
  taxYear: 2027,
  taxInventoryRunId: 'inventory-1',
  taxEstimateId: 'estimate-1',
  lotRunId: 'lot-1',
  sourceLedgerGenerationId: 'ledger-generation-1',
  schemaDigest: digest('1'),
  artifactRoots: [{ kind: 'TAX_INVENTORY', digest: digest('2') }],
  evidenceCoordinates: [{
    kind: 'POSTING', eventId: 'event-1', revisionId: 'revision-1',
    legId: 'leg-1', movementId: 'movement-1',
  }],
  sourceCoverage: [{
    sourceArtifactId: 'source-1',
    sourceKind: 'FILE',
    assurance: 'DOCUMENT_METADATA_VERIFIED',
    status: 'PARTIAL',
    evidenceDigest: digest('3'),
    fragmentIds: ['fragment-1'],
    coveredIntervals: [{
      from: '2026-12-31T15:00:00Z',
      through: '2027-06-30T14:59:59.999999999Z',
    }],
    uncoveredIntervals: [{
      from: '2027-06-30T15:00:00Z',
      through: '2027-12-31T14:59:59.999999999Z',
    }],
  }],
  policy: {
    name: 'kr-virtual-asset-tax',
    version: '2027.1',
    artifactDigest: digest('4'),
    sourceSetDigest: digest('5'),
    applicationMode: 'ENACTED',
    effectiveFrom: '2027-01-01T00:00:00Z',
    effectiveThrough: '2027-12-31T23:59:59Z',
    legalReferences: [{
      law: '소득세법', article: '제37조', purpose: '필요경비 계산 기준',
    }],
  },
  engine: {
    name: 'daejang-tax-engine', version: '2.0.0', artifactDigest: digest('6'),
  },
  issuedAt: '2027-07-01T00:00:00Z',
})

const artifact = (value: unknown): TaxEvidencePackArtifact => {
  const canonicalJson = Buffer.from(canonicalStringify(value))
  return {
    reportId,
    artifactDigest: createHash('sha256').update(canonicalJson).digest('hex'),
    mediaType: TAX_EVIDENCE_PACK_V2_MEDIA_TYPE,
    canonicalJson,
  }
}

describe('EvidencePack V2 public projection', () => {
  it('preserves allowlisted coverage and evidence while hiding ownership', () => {
    const projected = decodeAndProjectTaxEvidencePackV2(
      artifact(evidenceFixture()),
      reportId,
    )

    expect(projected).toMatchObject({
      reportId,
      sourceCoverage: [{ sourceArtifactId: 'source-1', status: 'PARTIAL' }],
      methodology: {
        sourceLedgerGenerationId: 'ledger-generation-1',
        policy: { legalReferences: [{ law: '소득세법' }] },
      },
    })
    expect(projected).not.toHaveProperty('subjectId')
    expect(projected).not.toHaveProperty('residentId')
  })

  it('fails closed on an unrecognized root field', () => {
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact({ ...evidenceFixture(), residentDisplayName: 'private-name' }),
      reportId,
    )).toThrow(InvalidTaxEvidencePackV2Error)
  })

  it('rejects the DB report generation field at the artifact boundary', () => {
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact({ ...evidenceFixture(), generationId: 'db-generation-1' }),
      reportId,
    )).toThrow(InvalidTaxEvidencePackV2Error)
  })

  it('serializes the exact public evidence allowlist', async () => {
    const projected = decodeAndProjectTaxEvidencePackV2(
      artifact(evidenceFixture()),
      reportId,
    )
    const app = Fastify({ logger: false })
    app.get('/', {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['evidencePack'],
            properties: { evidencePack: publicTaxEvidencePackV2Schema },
          },
        },
      },
    }, async () => ({ evidencePack: projected }))

    try {
      const response = await app.inject({ method: 'GET', url: '/' })
      expect(response.statusCode).toBe(200)
      expect(response.json().evidencePack).toEqual(projected)
      expect(response.body).not.toContain('private-subject')
      expect(response.body).not.toContain('private-resident')
    } finally {
      await app.close()
    }
  })
})
