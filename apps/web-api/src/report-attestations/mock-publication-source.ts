import type {
  ReportAttestationPublication,
  ReportAttestationPublicationSource,
} from './publication-source.js'

export const MOCK_REPORT_ID = 'giwa-local-report-2025'
export const MOCK_REPORT_REVISION = 1

const PUBLICATION_FIXTURE = Object.freeze({
  schemaVersion: 'giwa.report.publication.v1',
  taxYear: 2025,
  transactionCount: 12,
  completeCount: 10,
  exceptionCount: 2,
  denomination: 'KRW',
  resultClass: 'SYNTHETIC_REVIEW_READY',
  derivationRuleVersion: 'giwa.local.fixture.v1',
  evidenceSchemaVersion: 'giwa.report.evidence.v1',
})

const CANONICAL_PUBLICATION_JSON = JSON.stringify(PUBLICATION_FIXTURE)
const CANONICAL_PUBLICATION_BYTES = new TextEncoder().encode(
  CANONICAL_PUBLICATION_JSON,
)

export type MockReportPublication = ReportAttestationPublication & Readonly<{
  reportId: typeof MOCK_REPORT_ID
  revision: typeof MOCK_REPORT_REVISION
}>

/**
 * Returns a copy so test-only mutation cannot modify the server-owned fixture
 * for later requests.
 */
export const getMockReportPublication = (): MockReportPublication => ({
  reportId: MOCK_REPORT_ID,
  revision: MOCK_REPORT_REVISION,
  safeArtifactBytes: CANONICAL_PUBLICATION_BYTES.slice(),
})

export const getMockPublicationCanonicalJson = () =>
  CANONICAL_PUBLICATION_JSON

export class MockReportAttestationPublicationSource
  implements ReportAttestationPublicationSource
{
  async getPublication(
    _ownerId: string,
    reportId: string,
  ): Promise<MockReportPublication | undefined> {
    return reportId === MOCK_REPORT_ID
      ? getMockReportPublication()
      : undefined
  }
}
