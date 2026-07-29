import type { ReportAttestationRecord } from './types.js'

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

export class MemoryReportAttestationStore {
  readonly durable = false
  readonly #records = new Map<string, ReportAttestationRecord>()
  readonly #globalClaims = new Map<string, string>()

  async create(record: ReportAttestationRecord) {
    const key = this.#key(record.ownerId, record.reportId)
    const existing = this.#records.get(key)
    if (existing) {
      return { result: 'EXISTS' as const, record: cloneRecord(existing) }
    }
    const claims = this.#claimKeys(record)
    if (claims.some((claim) => this.#globalClaims.has(claim))) {
      return { result: 'IDENTITY_CLAIMED' as const }
    }
    const stored = cloneRecord(record)
    this.#records.set(key, stored)
    for (const claim of claims) {
      this.#globalClaims.set(claim, key)
    }
    return { result: 'CREATED' as const, record: cloneRecord(stored) }
  }

  async get(ownerId: string, reportId: string) {
    const record = this.#records.get(this.#key(ownerId, reportId))
    return record ? cloneRecord(record) : undefined
  }

  async update(
    ownerId: string,
    reportId: string,
    transition: (
      current: ReportAttestationRecord,
    ) => ReportAttestationRecord | undefined,
  ) {
    const key = this.#key(ownerId, reportId)
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
      replacement.preparedRecordId !== current.preparedRecordId ||
      replacement.contractReportId.toLowerCase() !==
        current.contractReportId.toLowerCase() ||
      replacement.revision !== current.revision
    ) {
      throw new Error('Report attestation identity fields cannot be changed')
    }
    const stored = cloneRecord(replacement)
    this.#records.set(key, stored)
    return cloneRecord(stored)
  }

  #key(ownerId: string, reportId: string) {
    return `${ownerId}\u0000${reportId}`
  }

  #claimKeys(record: ReportAttestationRecord) {
    return [
      `prepared:${record.preparedRecordId}`,
      `contract-report:${record.contractReportId.toLowerCase()}`,
    ]
  }
}
