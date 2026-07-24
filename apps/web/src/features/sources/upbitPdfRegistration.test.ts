import { describe, expect, it } from 'vitest'
import {
  initialUpbitPdfRegistrationState,
  upbitPdfRegistrationReducer,
  validateUpbitPdfFile,
  type UpbitPdfRegistrationState,
} from './upbitPdfRegistration.ts'

describe('upbitPdfRegistrationReducer', () => {
  it('moves an accepted PDF through review and source-saved completion', () => {
    const file = new File(['%PDF-1.7'], 'upbit-history.pdf', {
      type: 'application/pdf',
    })
    let state: UpbitPdfRegistrationState =
      initialUpbitPdfRegistrationState

    state = upbitPdfRegistrationReducer(state, {
      file,
      intentKey: 'intent-upbit-1',
      type: 'FILE_ACCEPTED',
    })

    expect(state).toMatchObject({
      error: null,
      file,
      intentKey: 'intent-upbit-1',
      status: 'SOURCE_EDITING',
      view: 'review',
    })

    state = upbitPdfRegistrationReducer(state, {
      type: 'SUBMIT_STARTED',
    })
    expect(state).toMatchObject({
      file,
      intentKey: 'intent-upbit-1',
      status: 'DOCUMENT_UPLOADING',
      view: 'submitting',
    })

    state = upbitPdfRegistrationReducer(state, {
      status: 'SOURCE_SUBMITTING',
      type: 'SUBMIT_STAGE_CHANGED',
    })
    state = upbitPdfRegistrationReducer(state, {
      sourceId: 'source-upbit-1',
      sourceStatus: 'UPLOADED',
      type: 'SUBMIT_SUCCEEDED',
    })

    expect(state).toEqual({
      fileSummary: {
        name: 'upbit-history.pdf',
        size: file.size,
      },
      sourceId: 'source-upbit-1',
      sourceStatus: 'UPLOADED',
      status: 'SOURCE_SAVED',
      view: 'complete',
    })
    expect('file' in state).toBe(false)
  })

  it('keeps the selected PDF and intent key after a retryable fixed-code failure', () => {
    const file = new File(['%PDF-1.7'], 'upbit-history.pdf', {
      type: 'application/pdf',
    })
    let state: UpbitPdfRegistrationState = upbitPdfRegistrationReducer(
      initialUpbitPdfRegistrationState,
      {
        file,
        intentKey: 'intent-upbit-retry',
        type: 'FILE_ACCEPTED',
      },
    )

    state = upbitPdfRegistrationReducer(state, {
      type: 'SUBMIT_STARTED',
    })
    state = upbitPdfRegistrationReducer(state, {
      error: {
        code: 'PROCESSING_FAILED',
        requestId: 'request-safe-1',
      },
      type: 'SUBMIT_FAILED',
    })

    expect(state).toMatchObject({
      error: {
        code: 'PROCESSING_FAILED',
        requestId: 'request-safe-1',
      },
      file,
      intentKey: 'intent-upbit-retry',
      status: 'SOURCE_SAVE_FAILED',
      view: 'review',
    })

    const retryingState = upbitPdfRegistrationReducer(state, {
      type: 'SUBMIT_STARTED',
    })
    expect(retryingState).toMatchObject({
      file,
      intentKey: 'intent-upbit-retry',
      status: 'DOCUMENT_UPLOADING',
      view: 'submitting',
    })
  })
})

describe('validateUpbitPdfFile', () => {
  it('accepts a non-empty PDF and rejects a non-PDF extension', () => {
    expect(
      validateUpbitPdfFile(
        new File(['%PDF-1.7'], 'history.PDF', {
          type: 'application/pdf',
        }),
      ),
    ).toBeNull()
    expect(
      validateUpbitPdfFile(
        new File(['date,asset'], 'history.csv', {
          type: 'text/csv',
        }),
      ),
    ).toEqual({ code: 'FILE_TYPE' })
  })
})
