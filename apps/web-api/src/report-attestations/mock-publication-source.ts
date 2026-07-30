import {
  getSyntheticTestnetPublicationCanonicalJson,
  getSyntheticTestnetReportPublication,
  SYNTHETIC_TESTNET_REPORT_ID,
  SYNTHETIC_TESTNET_REPORT_REVISION,
  SyntheticTestnetReportAttestationPublicationSource,
  type SyntheticTestnetReportPublication,
} from './synthetic-testnet-publication-source.js'

/**
 * Backward-compatible names for the disposable local Anvil test harness.
 * Production code imports the explicitly named synthetic testnet source.
 */
export const MOCK_REPORT_ID = SYNTHETIC_TESTNET_REPORT_ID
export const MOCK_REPORT_REVISION = SYNTHETIC_TESTNET_REPORT_REVISION
export type MockReportPublication = SyntheticTestnetReportPublication
export const getMockReportPublication =
  getSyntheticTestnetReportPublication
export const getMockPublicationCanonicalJson =
  getSyntheticTestnetPublicationCanonicalJson
export class MockReportAttestationPublicationSource extends SyntheticTestnetReportAttestationPublicationSource {}
