export type ReportAttestationPublication = Readonly<{
  /**
   * Public product report identifier used by the Daejang API and UI.
   * The contract-facing bytes32 report ID remains server-derived.
   */
  reportId: string
  revision: number
  /**
   * Canonical, privacy-reviewed bytes used to calculate the commitment.
   * Raw source documents and sensitive report fields must not be included.
   */
  safeArtifactBytes: Uint8Array
}>

/**
 * Swap boundary between GIWA-28 and the report-producing system.
 *
 * The local demo supplies a fixed mock publication. The future Report Engine
 * adapter will load an owner-scoped, immutable report publication and return
 * the same three fields without changing the attestation lifecycle.
 */
export interface ReportAttestationPublicationSource {
  getPublication(
    ownerId: string,
    reportId: string,
  ): Promise<ReportAttestationPublication | undefined>
}
