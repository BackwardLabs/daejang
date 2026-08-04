import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  decodeAndProjectTaxEvidencePack,
  InvalidTaxEvidencePackError,
} from './evidence-pack.js'
import {
  TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
} from './model-reader.js'

const REPORT_ID = `tax-report:${'a'.repeat(64)}`

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`
}

const pack = {
  schemaVersion: 'giwa.tax-evidence-pack.v1',
  manifestId: `tax-evidence-pack:${'9'.repeat(64)}`,
  reportId: REPORT_ID,
  subjectId: 'subject-private-value',
  residentId: 'resident-private-value',
  taxYear: 2027,
  taxInventoryRunId: 'tax-inventory-run-1',
  taxEstimateId: 'tax-estimate-1',
  lotRunId: 'lot-run-1',
  generationId: 'generation-1',
  schemaDigest: '1'.repeat(64),
  artifactRoots: [
    { kind: 'TAX_INVENTORY', digest: '2'.repeat(64) },
  ],
  evidenceCoordinates: [
    {
      kind: 'POSTING',
      eventId: 'event-1',
      revisionId: 'revision-1',
      legId: 'leg-1',
      movementId: 'movement-1',
    },
  ],
  policy: {
    name: 'giwa-korea-tax-policy',
    version: '2027.1',
    artifactDigest: '3'.repeat(64),
  },
  engine: {
    name: 'giwa-tax-engine',
    version: '1.0.0',
    artifactDigest: '4'.repeat(64),
  },
  issuedAt: '2028-01-10T00:00:00Z',
}

const artifactFor = (value: unknown): TaxEvidencePackArtifact => {
  const canonicalJsonBytes = Buffer.from(canonicalJson(value), 'utf8')
  return {
    reportId: REPORT_ID,
    artifactDigest: createHash('sha256')
      .update(canonicalJsonBytes)
      .digest('hex'),
    mediaType: TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
    canonicalJson: canonicalJsonBytes,
  }
}

describe('tax evidence pack projection', () => {
  it('keeps trace coordinates while stripping subject and resident identities', () => {
    const projected = decodeAndProjectTaxEvidencePack(
      artifactFor(pack),
      REPORT_ID,
    )

    expect(projected).toMatchObject({
      reportId: REPORT_ID,
      taxYear: 2027,
      artifactRoots: [{ kind: 'TAX_INVENTORY' }],
      evidenceCoordinates: [
        {
          kind: 'POSTING',
          eventId: 'event-1',
          revisionId: 'revision-1',
          legId: 'leg-1',
          movementId: 'movement-1',
          valuationId: null,
        },
      ],
    })
    expect(projected).not.toHaveProperty('subjectId')
    expect(projected).not.toHaveProperty('residentId')
    expect(JSON.stringify(projected)).not.toContain(pack.subjectId)
    expect(JSON.stringify(projected)).not.toContain(pack.residentId)
  })

  it('fails closed on unknown fields and digest mismatch', () => {
    expect(() =>
      decodeAndProjectTaxEvidencePack(
        artifactFor({ ...pack, rawEvidence: 'not allowed' }),
        REPORT_ID,
      ),
    ).toThrow(InvalidTaxEvidencePackError)

    expect(() =>
      decodeAndProjectTaxEvidencePack(
        { ...artifactFor(pack), artifactDigest: 'f'.repeat(64) },
        REPORT_ID,
      ),
    ).toThrow(InvalidTaxEvidencePackError)
  })

  it('rejects non-canonical bytes even when their digest is correct', () => {
    const nonCanonicalBytes = Buffer.from(JSON.stringify(pack, null, 2), 'utf8')
    const nonCanonicalArtifact: TaxEvidencePackArtifact = {
      reportId: REPORT_ID,
      artifactDigest: createHash('sha256')
        .update(nonCanonicalBytes)
        .digest('hex'),
      mediaType: TAX_EVIDENCE_PACK_V1_MEDIA_TYPE,
      canonicalJson: nonCanonicalBytes,
    }

    expect(() =>
      decodeAndProjectTaxEvidencePack(nonCanonicalArtifact, REPORT_ID),
    ).toThrow(InvalidTaxEvidencePackError)
  })

  it('rejects malformed manifest and empty generation identities', () => {
    expect(() =>
      decodeAndProjectTaxEvidencePack(
        artifactFor({ ...pack, manifestId: 'tax-evidence-pack:not-a-digest' }),
        REPORT_ID,
      ),
    ).toThrow(InvalidTaxEvidencePackError)

    expect(() =>
      decodeAndProjectTaxEvidencePack(
        artifactFor({ ...pack, generationId: '' }),
        REPORT_ID,
      ),
    ).toThrow(InvalidTaxEvidencePackError)
  })
})
