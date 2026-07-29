import { ApiClientError, requestApi, requestRaw } from '../../api/client.ts'
import {
  type RegisterUpbitPdf,
  type UpbitPdfRegistrationErrorCode,
} from './upbitPdfRegistration.ts'

class UploadSessionUnavailableError extends Error {
  readonly intentKey: string

  constructor(intentKey: string) {
    super('Upload session cannot continue.')
    this.name = 'UploadSessionUnavailableError'
    this.intentKey = intentKey
  }
}

const isAbortError = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError'

const errorCode = (error: unknown): UpbitPdfRegistrationErrorCode => {
  if (isAbortError(error)) return 'UPLOAD_CANCELLED'
  if (error instanceof ApiClientError) {
    if (error.code === 'PDF_PASSWORD_INVALID') return 'PASSWORD_INVALID'
    if (error.code === 'VERIFIED_IDENTITY_REQUIRED') return 'IDENTITY_VERIFICATION_REQUIRED'
    if (error.code === 'IMPORT_IN_PROGRESS') return 'PROCESSING_TIMEOUT'
    if (error.code === 'SUBJECT_MISMATCH') return 'SUBJECT_MISMATCH'
    if (error.status === 409) return 'DUPLICATE_SOURCE'
    if (error.code === 'UPBIT_PDF_LAYOUT_UNSUPPORTED') return 'UNSUPPORTED_DOCUMENT'
    if (error.code === 'INVALID_PDF') return 'ENCRYPTED_OR_DAMAGED_DOCUMENT'
    if (error.code === 'INVALID_COVERAGE_PERIOD') return 'INVALID_PERIOD'
    if (error.status >= 500) return 'PROCESSING_FAILED'
  }
  return 'UPLOAD_FAILED'
}

type ImportResponse = {
  source: { id: string }
  job: { id: string; state: string }
  evidenceTerminalStatus: 'COMPLETE' | 'PARTIAL'
  sourceRecordCount: number
  normalizedRecordCount: number
}

export const createRegisterUpbitPdfApi = (
  encodePassword: (value: string) => Uint8Array = (value) => new TextEncoder().encode(value),
): RegisterUpbitPdf => async ({
  file,
  intentKey,
  retry,
  password,
  coverageStart,
  coverageEnd,
  onStageChange,
  signal,
}) => {
  let passwordBytes: Uint8Array | undefined
  let passwordEnvelope: Uint8Array | undefined
  try {
    if (signal.aborted) throw new DOMException('PDF import was aborted.', 'AbortError')
    onStageChange('DOCUMENT_PREPARING')
    passwordBytes = encodePassword(password ?? '')
    if (passwordBytes.byteLength > 256) {
      throw new Error('PDF password is too long.')
    }
    passwordEnvelope = new Uint8Array(passwordBytes.byteLength + 1)
    passwordEnvelope[0] = 1
    passwordEnvelope.set(passwordBytes, 1)
    password = null

    onStageChange('DOCUMENT_UPLOADING')
    const uploadIntent = retry?.mode === 'restart-upload'
      ? retry.intentKey
      : intentKey
    const upload = await requestApi<{
      uploadId: string
      uploadUrl: string
      state: string
    }>('/uploads', {
      method: 'POST',
      signal,
      body: JSON.stringify({
        filename: file.name,
        mediaType: 'application/pdf',
        sizeBytes: file.size,
        intentKey: uploadIntent,
      }),
    })
    if (upload.state === 'PENDING') {
      await requestRaw(upload.uploadUrl.replace(/^\/api\/v1/, ''), {
        method: 'PUT',
        signal,
        body: file,
        headers: { 'content-type': 'application/pdf' },
      })
    } else if (upload.state !== 'UPLOADED' && upload.state !== 'CONFIRMED') {
      throw new UploadSessionUnavailableError(uploadIntent)
    }

    onStageChange('SOURCE_SUBMITTING')
    const query = new URLSearchParams({ coverageStart, coverageEnd })
    const imported = await requestApi<ImportResponse>(
      `/uploads/${upload.uploadId}/import?${query.toString()}`,
      {
        method: 'POST',
        signal,
        body: passwordEnvelope.buffer as ArrayBuffer,
        headers: { 'content-type': 'application/octet-stream' },
      },
    )
    onStageChange('DOCUMENT_PROCESSING')
    if (imported.job.state !== 'SUCCEEDED') {
      return {
        ok: false,
        error: { code: 'PROCESSING_FAILED', requestId: imported.job.id },
      }
    }
    return {
      ok: true,
      sourceId: imported.source.id,
      sourceStatus: 'UPLOADED',
      evidenceTerminalStatus: imported.evidenceTerminalStatus,
      sourceRecordCount: imported.sourceRecordCount,
      normalizedRecordCount: imported.normalizedRecordCount,
    }
  } catch (error) {
    if (isAbortError(error)) throw error
    if (error instanceof UploadSessionUnavailableError) {
      return {
        ok: false,
        error: {
          code: 'UPLOAD_FAILED',
          retry: { mode: 'restart-upload', intentKey: error.intentKey },
        },
      }
    }
    return {
      ok: false,
      error: {
        code: errorCode(error),
        ...(error instanceof ApiClientError ? { requestId: error.code } : {}),
      },
    }
  } finally {
    passwordBytes?.fill(0)
    passwordEnvelope?.fill(0)
  }
}

export const registerUpbitPdfApi = createRegisterUpbitPdfApi()
