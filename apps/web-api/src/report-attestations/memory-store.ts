import type { ReportAttestationRecord } from './types.js'
import type {
  ReportAttestationCreateResult,
  ReportAttestationStore,
} from './store.js'

const cloneRecord = (
  record: ReportAttestationRecord,
): ReportAttestationRecord => ({
  ...record,
  safeArtifactBytes: record.safeArtifactBytes.slice(),
  submission: record.submission ? { ...record.submission } : undefined,
  review: record.review ? { ...record.review } : undefined,
  createdAt: new Date(record.createdAt),
  updatedAt: new Date(record.updatedAt),
})

export class MemoryReportAttestationStore
  implements ReportAttestationStore
{
  readonly durable = false
  readonly #records = new Map<string, ReportAttestationRecord>()
  readonly #preparedRecordClaims = new Map<string, string>()
  readonly #contractReportBindings = new Map<string, string>()
  readonly #logicalReportBindings = new Map<string, string>()

  async create(
    record: ReportAttestationRecord,
  ): Promise<ReportAttestationCreateResult> {
    const logicalKey = this.#logicalKey(record.ownerId, record.reportId)
    const key = this.#key(
      record.ownerId,
      record.reportId,
      record.revision,
    )
    const preparedClaim = record.preparedRecordId
    const contractClaim = record.contractReportId.toLowerCase()
    const existing = this.#records.get(key)
    if (existing) {
      if (
        existing.preparedRecordId !== preparedClaim ||
        existing.contractReportId.toLowerCase() !== contractClaim
      ) {
        return { result: 'IDENTITY_CLAIMED' as const }
      }
      return { result: 'EXISTS' as const, record: cloneRecord(existing) }
    }
    const boundLogicalKey =
      this.#contractReportBindings.get(contractClaim)
    const boundContractClaim =
      this.#logicalReportBindings.get(logicalKey)
    if (
      this.#preparedRecordClaims.has(preparedClaim) ||
      (boundLogicalKey !== undefined &&
        boundLogicalKey !== logicalKey) ||
      (boundContractClaim !== undefined &&
        boundContractClaim !== contractClaim)
    ) {
      return { result: 'IDENTITY_CLAIMED' as const }
    }
    const stored = cloneRecord(record)
    this.#records.set(key, stored)
    this.#preparedRecordClaims.set(preparedClaim, key)
    this.#contractReportBindings.set(contractClaim, logicalKey)
    this.#logicalReportBindings.set(logicalKey, contractClaim)
    return { result: 'CREATED' as const, record: cloneRecord(stored) }
  }

  async get(
    ownerId: string,
    reportId: string,
    revision?: number,
  ) {
    const record =
      revision === undefined
        ? this.#latest(ownerId, reportId)
        : this.#records.get(
            this.#key(ownerId, reportId, revision),
          )
    return record ? cloneRecord(record) : undefined
  }

  async getByPreparedRecordId(preparedRecordId: string) {
    for (const record of this.#records.values()) {
      if (record.preparedRecordId === preparedRecordId) {
        return { record: cloneRecord(record) }
      }
    }
    return undefined
  }

  async update(
    ownerId: string,
    reportId: string,
    revision: number,
    transition: (
      current: ReportAttestationRecord,
    ) => ReportAttestationRecord | undefined,
  ) {
    const key = this.#key(ownerId, reportId, revision)
    const current = this.#records.get(key)
    if (!current) {
      return undefined
    }
    const replacement = transition(cloneRecord(current))
    if (!replacement) {
      return undefined
    }
    if (
      replacement.ownerId !== ownerId ||
      replacement.reportId !== reportId ||
      replacement.publicationSourceVersion !==
        current.publicationSourceVersion ||
      replacement.preparedRecordId !== current.preparedRecordId ||
      replacement.contractReportId.toLowerCase() !==
        current.contractReportId.toLowerCase() ||
      replacement.revision !== current.revision ||
      replacement.previousSubmissionUID.toLowerCase() !==
        current.previousSubmissionUID.toLowerCase() ||
      replacement.desiredReviewOutcome !==
        current.desiredReviewOutcome
    ) {
      throw new Error('Report attestation identity fields cannot be changed')
    }
    const stored = cloneRecord(replacement)
    this.#records.set(key, stored)
    return cloneRecord(stored)
  }

  #logicalKey(ownerId: string, reportId: string) {
    return `${ownerId}\u0000${reportId}`
  }

  #key(ownerId: string, reportId: string, revision: number) {
    return `${this.#logicalKey(ownerId, reportId)}\u0000${revision}`
  }

  #latest(ownerId: string, reportId: string) {
    const prefix = `${this.#logicalKey(ownerId, reportId)}\u0000`
    let latest: ReportAttestationRecord | undefined
    for (const [key, record] of this.#records) {
      if (
        key.startsWith(prefix) &&
        (!latest || record.revision > latest.revision)
      ) {
        latest = record
      }
    }
    return latest
  }
}
