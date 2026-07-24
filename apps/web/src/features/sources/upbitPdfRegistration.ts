export type UpbitPdfSelectionErrorCode =
  | 'EMPTY_FILE'
  | 'FILE_COUNT'
  | 'FILE_REQUIRED'
  | 'FILE_TYPE'

export type UpbitPdfRegistrationErrorCode =
  | 'DUPLICATE_SOURCE'
  | 'ENCRYPTED_OR_DAMAGED_DOCUMENT'
  | 'PASSWORD_INVALID'
  | 'PROCESSING_FAILED'
  | 'UNSUPPORTED_DOCUMENT'
  | 'UPLOAD_CANCELLED'
  | 'UPLOAD_FAILED'

export type UpbitPdfSelectionError = {
  code: UpbitPdfSelectionErrorCode
}

export type UpbitPdfRegistrationError = {
  code: UpbitPdfRegistrationErrorCode
  requestId?: string
}

type SelectedFile = {
  file: File
  intentKey: string
}

export type UpbitPdfRegistrationState =
  | {
      error: UpbitPdfSelectionError | null
      file: File | null
      status: 'SOURCE_EDITING'
      view: 'select'
    }
  | (SelectedFile & {
      error: UpbitPdfRegistrationError | null
      status: 'SOURCE_EDITING' | 'SOURCE_SAVE_FAILED'
      view: 'review'
    })
  | (SelectedFile & {
      status: 'DOCUMENT_UPLOADING' | 'SOURCE_SUBMITTING'
      view: 'submitting'
    })
  | {
      fileSummary: {
        name: string
        size: number
      }
      sourceId: string
      sourceStatus: 'SOURCE_SAVED'
      status: 'SOURCE_SAVED'
      view: 'complete'
    }

export type UpbitPdfRegistrationAction =
  | {
      error: UpbitPdfSelectionError
      type: 'FILE_REJECTED'
    }
  | {
      file: File
      intentKey: string
      type: 'FILE_ACCEPTED'
    }
  | {
      type: 'CONTINUE_TO_REVIEW'
    }
  | {
      type: 'BACK_TO_SELECT'
    }
  | {
      type: 'REPLACE_FILE'
    }
  | {
      type: 'SUBMIT_STARTED'
    }
  | {
      status: 'DOCUMENT_UPLOADING' | 'SOURCE_SUBMITTING'
      type: 'SUBMIT_STAGE_CHANGED'
    }
  | {
      error: UpbitPdfRegistrationError
      type: 'SUBMIT_FAILED'
    }
  | {
      type: 'SUBMIT_CANCELLED'
    }
  | {
      sourceId: string
      sourceStatus: 'SOURCE_SAVED'
      type: 'SUBMIT_SUCCEEDED'
    }
  | {
      type: 'RESET'
    }

export const initialUpbitPdfRegistrationState: UpbitPdfRegistrationState = {
  error: null,
  file: null,
  status: 'SOURCE_EDITING',
  view: 'select',
}

export function upbitPdfRegistrationReducer(
  state: UpbitPdfRegistrationState,
  action: UpbitPdfRegistrationAction,
): UpbitPdfRegistrationState {
  switch (action.type) {
    case 'FILE_REJECTED':
      return {
        error: action.error,
        file: null,
        status: 'SOURCE_EDITING',
        view: 'select',
      }
    case 'FILE_ACCEPTED':
      return {
        error: null,
        file: action.file,
        intentKey: action.intentKey,
        status: 'SOURCE_EDITING',
        view: 'review',
      }
    case 'CONTINUE_TO_REVIEW':
      if (state.view !== 'select' || !state.file) {
        return state
      }

      return {
        error: null,
        file: state.file,
        intentKey: createUpbitPdfIntentKey(),
        status: 'SOURCE_EDITING',
        view: 'review',
      }
    case 'BACK_TO_SELECT':
      if (state.view !== 'review') {
        return state
      }

      return {
        error: null,
        file: state.file,
        status: 'SOURCE_EDITING',
        view: 'select',
      }
    case 'REPLACE_FILE':
    case 'RESET':
      return initialUpbitPdfRegistrationState
    case 'SUBMIT_STARTED':
      if (state.view !== 'review') {
        return state
      }

      return {
        file: state.file,
        intentKey: state.intentKey,
        status: 'DOCUMENT_UPLOADING',
        view: 'submitting',
      }
    case 'SUBMIT_STAGE_CHANGED':
      if (state.view !== 'submitting') {
        return state
      }

      return {
        ...state,
        status: action.status,
      }
    case 'SUBMIT_FAILED':
      if (state.view !== 'submitting') {
        return state
      }

      return {
        error: action.error,
        file: state.file,
        intentKey: state.intentKey,
        status: 'SOURCE_SAVE_FAILED',
        view: 'review',
      }
    case 'SUBMIT_CANCELLED':
      if (state.view !== 'submitting') {
        return state
      }

      return {
        error: { code: 'UPLOAD_CANCELLED' },
        file: state.file,
        intentKey: state.intentKey,
        status: 'SOURCE_EDITING',
        view: 'review',
      }
    case 'SUBMIT_SUCCEEDED':
      if (state.view !== 'submitting') {
        return state
      }

      return {
        fileSummary: {
          name: state.file.name,
          size: state.file.size,
        },
        sourceId: action.sourceId,
        sourceStatus: action.sourceStatus,
        status: 'SOURCE_SAVED',
        view: 'complete',
      }
  }
}

export function validateUpbitPdfFile(
  file: File | null | undefined,
): UpbitPdfSelectionError | null {
  if (!file) {
    return { code: 'FILE_REQUIRED' }
  }

  if (!file.name.trim().toLocaleLowerCase().endsWith('.pdf')) {
    return { code: 'FILE_TYPE' }
  }

  if (file.size === 0) {
    return { code: 'EMPTY_FILE' }
  }

  return null
}

let fallbackIntentSequence = 0

export function createUpbitPdfIntentKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  fallbackIntentSequence += 1
  return `upbit-pdf-${Date.now()}-${fallbackIntentSequence}`
}

export type UpbitPdfRegistrationResult =
  | {
      ok: true
      sourceId: string
      sourceStatus: 'SOURCE_SAVED'
    }
  | {
      error: UpbitPdfRegistrationError
      ok: false
    }

export type UpbitPdfRegistrationRequest = {
  file: File
  intentKey: string
  onStageChange: (
    status: 'DOCUMENT_UPLOADING' | 'SOURCE_SUBMITTING',
  ) => void
  password: string | null
  signal: AbortSignal
}

export type RegisterUpbitPdf = (
  request: UpbitPdfRegistrationRequest,
) => Promise<UpbitPdfRegistrationResult>

function waitForMockBoundary(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('The registration was aborted.', 'AbortError'))
      return
    }

    function handleAbort() {
      window.clearTimeout(timeoutId)
      reject(new DOMException('The registration was aborted.', 'AbortError'))
    }

    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve()
    }, duration)

    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

/**
 * UI-only boundary for this stack. A later API stack can replace this function
 * with upload-session creation, a private presigned upload, and server confirm.
 */
export const registerUpbitPdfMock: RegisterUpbitPdf = async ({
  onStageChange,
  signal,
}) => {
  onStageChange('DOCUMENT_UPLOADING')
  await waitForMockBoundary(240, signal)
  onStageChange('SOURCE_SUBMITTING')
  await waitForMockBoundary(320, signal)

  return {
    ok: true,
    sourceId: 'src_upbit_preview',
    sourceStatus: 'SOURCE_SAVED',
  }
}

export function formatPdfFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const kilobytes = bytes / 1024
  if (kilobytes < 1024) {
    return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`
  }

  const megabytes = kilobytes / 1024
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`
}
