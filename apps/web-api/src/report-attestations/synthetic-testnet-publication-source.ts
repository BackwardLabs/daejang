import { createHash } from 'node:crypto'

import type {
  ReportAttestationPublication,
  ReportAttestationPublicationSource,
} from './publication-source.js'

export const SYNTHETIC_TESTNET_REPORT_ID =
  'giwa-sepolia-synthetic-report-2025'
export const SYNTHETIC_TESTNET_REPORT_REVISION = 1
export const SYNTHETIC_TESTNET_PREVIOUS_SUBMISSION_UID =
  `0x${'0'.repeat(64)}` as const
export const SYNTHETIC_TESTNET_DERIVATION_RULE_DIGEST =
  `0x${createHash('sha256')
    .update('giwa.sepolia.synthetic-publication.v1', 'utf8')
    .digest('hex')}` as const

export const SYNTHETIC_TESTNET_REPORT_SUMMARY = Object.freeze({
  taxYear: 2025,
  transactionCount: 12,
  completeCount: 10,
  exceptionCount: 2,
  denomination: 'KRW',
})

const PUBLICATION = Object.freeze({
  schemaVersion: 'giwa.report.publication.v1',
  ...SYNTHETIC_TESTNET_REPORT_SUMMARY,
  resultClass: 'SYNTHETIC_REVIEW_READY',
  derivationRuleVersion: 'giwa.sepolia.synthetic-publication.v1',
  evidenceSchemaVersion: 'giwa.report.evidence.v1',
})

const CANONICAL_PUBLICATION_JSON = JSON.stringify(PUBLICATION)
const CANONICAL_PUBLICATION_BYTES = new TextEncoder().encode(
  CANONICAL_PUBLICATION_JSON,
)

export type SyntheticTestnetReportPublication =
  ReportAttestationPublication &
    Readonly<{
      reportId: typeof SYNTHETIC_TESTNET_REPORT_ID
      revision: typeof SYNTHETIC_TESTNET_REPORT_REVISION
    }>

export const getSyntheticTestnetReportPublication =
  (): SyntheticTestnetReportPublication => ({
    reportId: SYNTHETIC_TESTNET_REPORT_ID,
    sourceVersion: 'giwa.sepolia.synthetic-publication.v1',
    revision: SYNTHETIC_TESTNET_REPORT_REVISION,
    previousSubmissionUID:
      SYNTHETIC_TESTNET_PREVIOUS_SUBMISSION_UID,
    derivationRuleDigest:
      SYNTHETIC_TESTNET_DERIVATION_RULE_DIGEST,
    safeArtifactBytes: CANONICAL_PUBLICATION_BYTES.slice(),
  })

export const getSyntheticTestnetPublicationCanonicalJson = () =>
  CANONICAL_PUBLICATION_JSON

/**
 * Temporary GIWA Sepolia pilot source.
 *
 * The bytes contain only the privacy-reviewed allowlist above. This class is
 * intentionally behind an explicit server capability and can later be
 * replaced by a Report Engine implementation of the same source interface.
 */
export class SyntheticTestnetReportAttestationPublicationSource
  implements ReportAttestationPublicationSource
{
  async getPublication(
    _ownerId: string,
    reportId: string,
    revision?: number,
  ): Promise<SyntheticTestnetReportPublication | undefined> {
    return reportId === SYNTHETIC_TESTNET_REPORT_ID &&
      (revision === undefined ||
        revision === SYNTHETIC_TESTNET_REPORT_REVISION)
      ? getSyntheticTestnetReportPublication()
      : undefined
  }
}
