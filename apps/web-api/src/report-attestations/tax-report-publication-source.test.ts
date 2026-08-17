import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'

import {
  InconsistentTaxReportPublicationError,
  PostgresTaxReportAttestationPublicationSource,
  TAX_REPORT_DERIVATION_RULE_DIGEST,
} from './tax-report-publication-source.js'

const OWNER_ID = '00000000-0000-4000-8000-000000000028'
const REPORT_ID = `tax-report-v2:${'a'.repeat(64)}`

const row = (overrides: Record<string, unknown> = {}) => ({
  subject_id: OWNER_ID,
  report_id: REPORT_ID,
  tax_year: 2027,
  finality: 'FINAL',
  status: 'FINAL',
  filing_status: 'READY',
  generation_id: 'b'.repeat(64),
  generation_state: 'ACTIVE',
  bound_report_pointer_version: '4',
  report_model_v2_artifact_digest: 'c'.repeat(64),
  evidence_pack_v2_artifact_digest: 'd'.repeat(64),
  policy_artifact_digest: 'e'.repeat(64),
  coverage_status: 'COMPLETE',
  coverage_assurance: 'DOCUMENT_METADATA_VERIFIED',
  tax_year_close_status: 'CLOSED',
  calculated_as_of: new Date('2028-01-01T00:00:00.000Z'),
  is_current_report: true,
  is_current_tax_result: true,
  is_current_ledger_scope: true,
  is_current_source_coverage: true,
  ...overrides,
})

const sourceWithRows = (rows: unknown[]) => {
  const query = vi.fn(async () => ({ rows }))
  return {
    query,
    source: new PostgresTaxReportAttestationPublicationSource(
      { query } as unknown as Pool,
    ),
  }
}

describe('PostgresTaxReportAttestationPublicationSource', () => {
  it('builds deterministic privacy-safe bytes from the exact owner-scoped V2 binding', async () => {
    const { query, source } = sourceWithRows([row()])

    const publication = await source.getPublication(
      OWNER_ID,
      REPORT_ID,
    )

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as unknown as [
      string,
      unknown[],
    ]
    expect(sql).toContain(
      'reporting.activated_tax_report_read_v2',
    )
    expect(sql).not.toMatch(/(?:FROM|JOIN)\s+tax\./u)
    expect(params).toEqual([OWNER_ID, REPORT_ID])
    expect(publication).toMatchObject({
      reportId: REPORT_ID,
      revision: 1,
      sourceVersion: 'giwa.tax-report-publication.v3',
      derivationRuleDigest:
        TAX_REPORT_DERIVATION_RULE_DIGEST,
    })
    const safe = JSON.parse(
      new TextDecoder().decode(publication?.safeArtifactBytes),
    ) as Record<string, unknown>
    expect(safe).toEqual({
      calculatedAsOf: '2028-01-01T00:00:00.000Z',
      coverageAssurance: 'DOCUMENT_METADATA_VERIFIED',
      coverageStatus: 'COMPLETE',
      derivationRuleVersion:
        'giwa.tax-report-publication-allowlist.v3',
      evidencePackDigest: 'd'.repeat(64),
      filingStatus: 'READY',
      finality: 'FINAL',
      generationId: 'b'.repeat(64),
      policyArtifactDigest: 'e'.repeat(64),
      reportId: REPORT_ID,
      reportModelDigest: 'c'.repeat(64),
      reportPointerVersion: 4,
      reportStatus: 'FINAL',
      schemaVersion: 'giwa.tax-report.publication.v2',
      taxYear: 2027,
      taxYearCloseStatus: 'CLOSED',
    })
    expect(JSON.stringify(safe)).not.toMatch(
      /resident|amount|transaction|sourceArtifact/iu,
    )
  })

  it('fails closed for a stale or malformed activated binding', async () => {
    const { source } = sourceWithRows([
      row({ is_current_ledger_scope: false }),
    ])

    await expect(
      source.getPublication(OWNER_ID, REPORT_ID),
    ).rejects.toBeInstanceOf(
      InconsistentTaxReportPublicationError,
    )
  })

  it('publishes an exact current provisional review snapshot without claiming filing readiness', async () => {
    const { source } = sourceWithRows([
      row({
        finality: 'PROVISIONAL',
        status: 'PARTIAL',
        filing_status: 'BLOCKED',
        generation_state: 'REVIEW_REQUIRED',
        coverage_status: 'PARTIAL',
        tax_year_close_status: 'OPEN',
      }),
    ])

    const publication = await source.getPublication(OWNER_ID, REPORT_ID)
    const safe = JSON.parse(
      new TextDecoder().decode(publication?.safeArtifactBytes),
    ) as Record<string, unknown>
    expect(safe).toMatchObject({
      finality: 'PROVISIONAL',
      filingStatus: 'BLOCKED',
      reportStatus: 'PARTIAL',
      coverageStatus: 'PARTIAL',
      taxYearCloseStatus: 'OPEN',
    })
  })

  it('fails closed for an unreadable building generation', async () => {
    const { source } = sourceWithRows([
      row({ generation_state: 'BUILDING' }),
    ])

    await expect(source.getPublication(OWNER_ID, REPORT_ID))
      .rejects.toBeInstanceOf(InconsistentTaxReportPublicationError)
  })

  it('does not reinterpret a DB pointer version as an EAS revision', async () => {
    const { query, source } = sourceWithRows([row()])

    await expect(
      source.getPublication(OWNER_ID, REPORT_ID, 4),
    ).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })

  it('rehydrates an already attested immutable revision after it is superseded', async () => {
    const currentSource = sourceWithRows([row()]).source
    const { source } = sourceWithRows([
      row({
        generation_state: 'SUPERSEDED',
        is_current_report: false,
        is_current_tax_result: false,
        is_current_ledger_scope: false,
        is_current_source_coverage: false,
      }),
    ])

    await expect(
      source.getPublication(OWNER_ID, REPORT_ID),
    ).rejects.toBeInstanceOf(
      InconsistentTaxReportPublicationError,
    )
    const [current, historical] = await Promise.all([
      currentSource.getPublication(OWNER_ID, REPORT_ID),
      source.getPublication(OWNER_ID, REPORT_ID, 1),
    ])
    expect(historical).toMatchObject({
      reportId: REPORT_ID,
      revision: 1,
    })
    expect(historical?.safeArtifactBytes).toEqual(
      current?.safeArtifactBytes,
    )
  })

  it('does not expose another owner report', async () => {
    const { source } = sourceWithRows([
      row({ subject_id: 'another-owner' }),
    ])

    await expect(
      source.getPublication(OWNER_ID, REPORT_ID),
    ).rejects.toBeInstanceOf(
      InconsistentTaxReportPublicationError,
    )
  })
})
