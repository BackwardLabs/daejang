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

export interface UploadStore {
  readonly durable: boolean
  create(input: CreateUpload): Promise<UploadSession>
  write(userId: string, uploadId: string, contents: Buffer, now: Date): Promise<UploadSession | undefined>
  confirm(userId: string, uploadId: string, now: Date): Promise<UploadSession | undefined>
}

