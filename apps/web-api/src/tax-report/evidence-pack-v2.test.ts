import { createHash } from 'node:crypto'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'

import {
  assertTaxEvidencePackV2DecisionRoots,
  decodeAndProjectTaxEvidencePackV2,
  InvalidTaxEvidencePackV2Error,
  publicTaxEvidencePackV2Schema,
} from './evidence-pack-v2.js'
import {
  TAX_EVIDENCE_PACK_V2_MEDIA_TYPE,
  type TaxEvidencePackArtifact,
} from './model-reader.js'
import type { PublicTaxReportV2Detail } from './public-model-v2.js'

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
  artifactRoots: [
    { kind: 'LOT_RUN', digest: digest('1') },
    { kind: 'TAX_INVENTORY', digest: digest('2') },
    { kind: 'TAX_ESTIMATE', digest: digest('3') },
    { kind: 'REPORT_POLICY', digest: digest('4') },
    { kind: 'REPORT_ENGINE', digest: digest('5') },
    { kind: 'BASIS_ELECTION_EVIDENCE:BTC', digest: digest('7') },
    { kind: 'INCOME_POLICY_MAPPING:AIRDROP', digest: digest('8') },
  ],
  evidenceCoordinates: [{
    kind: 'POSTING', eventId: 'event-1', revisionId: 'revision-1',
    legId: 'leg-1', movementId: 'movement-1',
  }],
  sourceCoverage: [{
    sourceArtifactId: 'source-1',
    sourceKind: 'FILE',
    systemName: 'UPBIT',
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
    denominationAtomicDecimals: 8,
    roundingProfileStatus: 'ESTIMATE_ONLY_UNAPPROVED',
    legalReferences: [{
      law: '소득세법', article: '제37조', purpose: '필요경비 계산 기준',
      sourceLocators: ['https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405'],
      sourceCheckedAt: '2026-08-03T15:00:00Z',
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
      artifactRoots: [
        { kind: 'LOT_RUN', digest: digest('1') },
        { kind: 'TAX_INVENTORY', digest: digest('2') },
        { kind: 'TAX_ESTIMATE', digest: digest('3') },
        { kind: 'REPORT_POLICY', digest: digest('4') },
        { kind: 'REPORT_ENGINE', digest: digest('5') },
        { kind: 'BASIS_ELECTION_EVIDENCE:BTC', digest: digest('7') },
        { kind: 'INCOME_POLICY_MAPPING:AIRDROP', digest: digest('8') },
      ],
      sourceCoverage: [{
        sourceArtifactId: 'source-1', systemName: 'UPBIT', status: 'PARTIAL',
      }],
      methodology: {
        sourceLedgerGenerationId: 'ledger-generation-1',
        policy: {
          roundingProfileStatus: 'ESTIMATE_ONLY_UNAPPROVED',
          roundingProfileEvidenceDigest: null,
          legalReferences: [{
            law: '소득세법',
            sourceLocators: ['https://www.law.go.kr/LSW/lsInfoP.do?lsiSeq=280405'],
            sourceCheckedAt: '2026-08-03T15:00:00Z',
          }],
        },
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

  it('rejects unapproved rounding when an approval digest is attached', () => {
    const pack = evidenceFixture()
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact({
        ...pack,
        policy: { ...pack.policy, roundingProfileEvidenceDigest: digest('9') },
      }),
      reportId,
    )).toThrow(/rounding profile approval and evidence disagree/u)
  })

  it('rejects missing, duplicate, or unknown artifact roots', () => {
    const missing = evidenceFixture()
    missing.artifactRoots = missing.artifactRoots.filter(
      (root) => root.kind !== 'LOT_RUN',
    )
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact(missing), reportId,
    )).toThrow(/missing required LOT_RUN/u)

    const duplicate = evidenceFixture()
    duplicate.artifactRoots.push({ kind: 'TAX_INVENTORY', digest: digest('9') })
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact(duplicate), reportId,
    )).toThrow(/root kinds must be unique/u)

    const unknown = evidenceFixture()
    unknown.artifactRoots.push({ kind: 'PRIVATE_ACTOR', digest: digest('9') })
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact(unknown), reportId,
    )).toThrow(/not an allowlisted evidence root/u)

    const unsupportedSubtype = evidenceFixture()
    unsupportedSubtype.artifactRoots.push({
      kind: 'INCOME_POLICY_MAPPING:UNREVIEWED_REWARD', digest: digest('9'),
    })
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact(unsupportedSubtype), reportId,
    )).toThrow(/not an allowlisted evidence root/u)

    const namespacedAsset = evidenceFixture()
    namespacedAsset.artifactRoots = namespacedAsset.artifactRoots.map((root) =>
      root.kind === 'BASIS_ELECTION_EVIDENCE:BTC'
        ? { ...root, kind: 'BASIS_ELECTION_EVIDENCE:eip155:1:BTC' }
        : root)
    expect(() => decodeAndProjectTaxEvidencePackV2(
      artifact(namespacedAsset), reportId,
    )).not.toThrow()
  })

  it('binds decision evidence roots to the exact public report decisions', () => {
    const projected = decodeAndProjectTaxEvidencePackV2(
      artifact(evidenceFixture()), reportId,
    )
    const report = {
      reportId,
      evidencePackDigest: projected.artifactDigest,
      taxYear: 2027,
      methodology: {
        taxInventoryRunId: 'inventory-1', taxEstimateId: 'estimate-1',
        lotRunId: 'lot-1', sourceLedgerGenerationId: 'ledger-generation-1',
        schemaDigest: digest('1'), policy: projected.methodology.policy,
        engine: projected.methodology.engine,
      },
      issuedAt: projected.issuedAt,
      assetSummaries: [{
        taxAssetId: 'BTC', basisMode: 'DEEMED_EXPENSE_50',
        basisEvidenceDigest: digest('7'),
      }],
      acquisitions: [{
        incomePolicyMapping: {
          eventSubtype: 'AIRDROP', policyArtifactDigest: digest('8'),
        },
      }],
    } as unknown as PublicTaxReportV2Detail
    expect(() => assertTaxEvidencePackV2DecisionRoots(
      projected, report,
    )).not.toThrow()

    const mismatchedArtifact = structuredClone(projected)
    mismatchedArtifact.artifactDigest = digest('6')
    expect(() => assertTaxEvidencePackV2DecisionRoots(
      mismatchedArtifact, report,
    )).toThrow(/evidence pack methodology does not match/u)

    const mismatched = structuredClone(report)
    mismatched.assetSummaries[0]!.basisEvidenceDigest = digest('9')
    expect(() => assertTaxEvidencePackV2DecisionRoots(
      projected, mismatched,
    )).toThrow(/decision evidence roots do not match/u)

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
