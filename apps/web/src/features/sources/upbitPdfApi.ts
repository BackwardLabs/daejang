import { ApiClientError, requestApi, requestRaw } from '../../api/client.ts'
import type { RegisterUpbitPdf, UpbitPdfRegistrationErrorCode } from './upbitPdfRegistration.ts'

const errorCode = (error: unknown): UpbitPdfRegistrationErrorCode => {
  if (error instanceof DOMException && error.name === 'AbortError') return 'UPLOAD_CANCELLED'
  if (error instanceof ApiClientError) {
    if (error.status === 409) return 'DUPLICATE_SOURCE'
    if (error.code === 'INVALID_PDF') return 'ENCRYPTED_OR_DAMAGED_DOCUMENT'
    if (error.status >= 500) return 'PROCESSING_FAILED'
  }
  return 'UPLOAD_FAILED'
}

export const registerUpbitPdfApi: RegisterUpbitPdf = async ({
  file, intentKey, coverageStart, coverageEnd, onStageChange, signal,
}) => {
  try {
    onStageChange('DOCUMENT_UPLOADING')
    const upload = await requestApi<{ uploadId: string; uploadUrl: string }>('/uploads', {
      method: 'POST', signal, body: JSON.stringify({ filename: file.name, mediaType: 'application/pdf', sizeBytes: file.size, intentKey }),
    })
    await requestRaw(upload.uploadUrl.replace(/^\/api\/v1/, ''), {
      method: 'PUT', signal, body: file, headers: { 'content-type': 'application/pdf' },
    })
    onStageChange('SOURCE_SUBMITTING')
    const result = await requestApi<{ source: { id: string } }>(`/uploads/${upload.uploadId}/confirm`, {
      method: 'POST', signal, body: JSON.stringify({ coverageStart, coverageEnd }),
    })
    return { ok: true, sourceId: result.source.id, sourceStatus: 'UPLOADED' }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return { ok: false, error: { code: errorCode(error), ...(error instanceof ApiClientError ? { requestId: error.code } : {}) } }
  }
}

