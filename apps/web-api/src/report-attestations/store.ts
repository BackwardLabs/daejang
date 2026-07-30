import type { ReportAttestationRecord } from './types.js'

export type ReportAttestationCreateResult =
  | Readonly<{
      result: 'CREATED'
      record: ReportAttestationRecord
    }>
  | Readonly<{
      result: 'EXISTS'
      record: ReportAttestationRecord
    }>
  | Readonly<{
      result: 'IDENTITY_CLAIMED'
    }>

/**
 * Persistence boundary for one owner-scoped report attestation lifecycle.
 *
 * Implementations must serialize `update` for the same
 * owner/report/revision record. A durable implementation must also preserve
 * the record across process restarts and fail closed when an in-flight write
 * cannot be reconciled.
 */
export interface ReportAttestationStore {
  readonly durable: boolean
  create(
    record: ReportAttestationRecord,
  ): Promise<ReportAttestationCreateResult>
  get(
    ownerId: string,
    reportId: string,
    revision?: number,
  ): Promise<ReportAttestationRecord | undefined>
  getByPreparedRecordId(
    preparedRecordId: string,
  ): Promise<
    | Readonly<{
        record: ReportAttestationRecord
        databaseId?: string
      }>
    | undefined
  >
  update(
    ownerId: string,
    reportId: string,
    revision: number,
    transition: (
      current: ReportAttestationRecord,
    ) => ReportAttestationRecord | undefined,
  ): Promise<ReportAttestationRecord | undefined>
  /**
   * Marks work interrupted by a previous process as reconciliation-required.
   * It must never silently re-broadcast a transaction.
   */
  recoverInterrupted?(): Promise<number>
}
