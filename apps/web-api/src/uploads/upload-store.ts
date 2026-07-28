export type UploadSession = {
  id: string
  userId: string
  provider: 'UPBIT'
  objectKey: string
  originalFilename: string
  mediaType: 'application/pdf'
  expectedBytes: number
  state: 'PENDING' | 'UPLOADED' | 'CONFIRMED' | 'EXPIRED' | 'FAILED'
  idempotencyKey: string
  expiresAt: Date
  verifiedDigest?: string
  verifiedBytes?: number
}

export type CreateUpload = {
  userId: string
  originalFilename: string
  mediaType: 'application/pdf'
  expectedBytes: number
  idempotencyKey: string
  now: Date
}

export class UploadValidationError extends Error {
  readonly code: 'ENCRYPTED_PDF' | 'INVALID_PDF'

  constructor(code: 'ENCRYPTED_PDF' | 'INVALID_PDF') {
    super(code)
    this.name = 'UploadValidationError'
    this.code = code
  }
}

export type UploadCleanupResult = {
  examined: number
  removed: number
  missing: number
  retryPending: number
}

export interface UploadStore {
  readonly durable: boolean
  create(input: CreateUpload): Promise<UploadSession>
  write(userId: string, uploadId: string, contents: Buffer, now: Date): Promise<UploadSession | undefined>
  confirm(userId: string, uploadId: string, now: Date): Promise<UploadSession | undefined>
  discard(userId: string, uploadId: string): Promise<boolean>
  cleanupAbandoned(now: Date, limit?: number): Promise<UploadCleanupResult>
}
