import type { Hex32 } from './types.js'

export type ReportAttestationPublication = Readonly<{
  /**
   * Public product report identifier used by the Daejang API and UI.
   * The contract-facing bytes32 report ID remains server-derived.
   */
  reportId: string
  /**
   * Stable producer/version identifier used to re-load the exact canonical
   * bytes after a backend restart.
   */
  sourceVersion?: string
  revision: number
  /**
   * EAS refUID used to link a revision to its preceding SUBMIT attestation.
   * Revision 1 must use the zero bytes32 value.
   */
  previousSubmissionUID?: Hex32
  /**
   * Digest of the approved derivation policy that produced the safe,
   * commitment-bound projection. The raw source document is never included.
   */
  derivationRuleDigest?: Hex32
  /**
   * Canonical, privacy-reviewed bytes used to calculate the commitment.
   * Raw source documents and sensitive report fields must not be included.
   */
  safeArtifactBytes: Uint8Array
}>

/**
 * Swap boundary between GIWA-28 and the report-producing system.
 *
 * Local test fixtures and the product Tax Report adapter both return the same
 * owner-scoped immutable publication contract without changing the EAS
 * attestation lifecycle.
 */
export interface ReportAttestationPublicationSource {
  getPublication(
    ownerId: string,
    reportId: string,
    /**
     * When present, the source must return that immutable historical revision
     * rather than whichever revision is currently active.
     */
    revision?: number,
  ): Promise<ReportAttestationPublication | undefined>
}
