import { describe, expect, it } from 'vitest'
import {
  collectionPeriodReducer,
  createPreviewCollectionPeriodMock,
  initialCollectionPeriodState,
  loadCollectionPeriodSourceMock,
  previewCollectionPeriodMock,
  validateCollectionPeriodDraft,
  type CollectionPeriodState,
} from './collectionPeriod.ts'

describe('loadCollectionPeriodSourceMock', () => {
  it('returns coverage only for a source resolved in the mock workspace', async () => {
    const controller = new AbortController()

    await expect(
      loadCollectionPeriodSourceMock({
        signal: controller.signal,
        sourceId: 'src_upbit_preview',
      }),
    ).resolves.toMatchObject({
      context: {
        coverage: {
          endDate: '2027-12-31',
          startDate: '2027-01-01',
        },
        sourceId: 'src_upbit_preview',
        sourceStatus: 'SOURCE_SAVED',
        sourceType: 'UPBIT_PDF',
        timezone: 'Asia/Seoul',
      },
      ok: true,
    })

    await expect(
      loadCollectionPeriodSourceMock({
        signal: controller.signal,
        sourceId: 'unknown-or-other-workspace',
      }),
    ).resolves.toEqual({
      error: {
        code: 'SOURCE_CONTEXT_UNAVAILABLE',
        requestId: 'period-source-mock-unavailable',
      },
      ok: false,
    })
  })

  it('rejects an already-aborted source lookup', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      loadCollectionPeriodSourceMock({
        signal: controller.signal,
        sourceId: 'src_upbit_preview',
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})

describe('validateCollectionPeriodDraft', () => {
  it('reports required fields with names the form can map directly', () => {
    expect(
      validateCollectionPeriodDraft({
        mode: 'TAX_YEAR',
        taxYear: '',
      }),
    ).toEqual({
      code: 'INVALID_DATE_RANGE',
      fieldErrors: {
        taxYear: 'REQUIRED',
      },
    })

    expect(
      validateCollectionPeriodDraft({
        endDate: '',
        mode: 'CUSTOM',
        startDate: '',
      }),
    ).toEqual({
      code: 'INVALID_DATE_RANGE',
      fieldErrors: {
        endDate: 'REQUIRED',
        startDate: 'REQUIRED',
      },
    })
  })

  it('accepts strict real calendar dates and rejects rollover dates', () => {
    expect(
      validateCollectionPeriodDraft({
        endDate: '2024-02-29',
        mode: 'CUSTOM',
        startDate: '2024-01-01',
      }),
    ).toBeNull()

    expect(
      validateCollectionPeriodDraft({
        endDate: '2027-02-29',
        mode: 'CUSTOM',
        startDate: '2027-01-01',
      }),
    ).toEqual({
      code: 'INVALID_DATE_RANGE',
      fieldErrors: {
        endDate: 'INVALID_FORMAT',
      },
    })

    expect(
      validateCollectionPeriodDraft({
        endDate: '2027-12-31',
        mode: 'CUSTOM',
        startDate: '2027-1-01',
      }),
    ).toEqual({
      code: 'INVALID_DATE_RANGE',
      fieldErrors: {
        startDate: 'INVALID_FORMAT',
      },
    })
  })

  it('marks both custom date fields when the start is after the end', () => {
    expect(
      validateCollectionPeriodDraft({
        endDate: '2027-04-01',
        mode: 'CUSTOM',
        startDate: '2027-04-02',
      }),
    ).toEqual({
      code: 'INVALID_DATE_RANGE',
      fieldErrors: {
        endDate: 'START_AFTER_END',
        startDate: 'START_AFTER_END',
      },
    })
  })
})

describe('collectionPeriodReducer', () => {
  it('resets the draft and preview state when the source changes', async () => {
    const draft = {
      endDate: '2027-08-31',
      mode: 'CUSTOM' as const,
      startDate: '2027-03-01',
    }
    const controller = new AbortController()
    const preview = await previewCollectionPeriodMock({
      period: draft,
      signal: controller.signal,
      sourceId: 'source-upbit-first',
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) {
      throw new Error('Expected the mock preview to succeed.')
    }

    let state: CollectionPeriodState = initialCollectionPeriodState(
      'source-upbit-first',
      draft,
    )
    state = collectionPeriodReducer(state, { type: 'PREVIEW_STARTED' })
    state = collectionPeriodReducer(state, {
      preview,
      type: 'PREVIEW_SUCCEEDED',
    })

    expect(
      collectionPeriodReducer(state, {
        sourceId: 'source-upbit-second',
        type: 'SOURCE_CHANGED',
      }),
    ).toEqual({
      draft: {
        mode: 'TAX_YEAR',
        taxYear: '2027',
      },
      error: null,
      sourceId: 'source-upbit-second',
      status: 'PERIOD_EDITING',
    })
  })

  it('blocks an invalid draft before preview and preserves it', () => {
    const draft = {
      endDate: '2027-01-01',
      mode: 'CUSTOM' as const,
      startDate: '2027-12-31',
    }
    const editingState = collectionPeriodReducer(
      initialCollectionPeriodState('source-upbit-1'),
      {
        draft,
        type: 'DRAFT_CHANGED',
      },
    )

    expect(
      collectionPeriodReducer(editingState, {
        type: 'PREVIEW_STARTED',
      }),
    ).toEqual({
      draft,
      error: {
        code: 'INVALID_DATE_RANGE',
        fieldErrors: {
          endDate: 'START_AFTER_END',
          startDate: 'START_AFTER_END',
        },
      },
      sourceId: 'source-upbit-1',
      status: 'PERIOD_INVALID',
    })
  })

  it('keeps the draft after an adapter failure', () => {
    const draft = {
      endDate: '2027-12-31',
      mode: 'CUSTOM' as const,
      startDate: '2027-01-01',
    }
    let state: CollectionPeriodState = initialCollectionPeriodState(
      'source-upbit-1',
      draft,
    )

    state = collectionPeriodReducer(state, { type: 'PREVIEW_STARTED' })
    state = collectionPeriodReducer(state, {
      error: {
        code: 'PREVIEW_FAILED',
        requestId: 'request-safe-1',
      },
      type: 'PREVIEW_FAILED',
    })

    expect(state).toEqual({
      draft,
      error: {
        code: 'PREVIEW_FAILED',
        requestId: 'request-safe-1',
      },
      sourceId: 'source-upbit-1',
      status: 'PERIOD_INVALID',
    })
  })

  it('returns a ready draft to editing without losing user input', async () => {
    const draft = {
      endDate: '2027-08-31',
      mode: 'CUSTOM' as const,
      startDate: '2027-03-01',
    }
    const controller = new AbortController()
    const preview = await previewCollectionPeriodMock({
      period: draft,
      signal: controller.signal,
      sourceId: 'source-upbit-1',
    })
    expect(preview.ok).toBe(true)
    if (!preview.ok) {
      throw new Error('Expected the mock preview to succeed.')
    }

    let state: CollectionPeriodState = initialCollectionPeriodState(
      'source-upbit-1',
      draft,
    )
    state = collectionPeriodReducer(state, { type: 'PREVIEW_STARTED' })
    state = collectionPeriodReducer(state, {
      preview,
      type: 'PREVIEW_SUCCEEDED',
    })
    expect(state.status).toBe('READY_TO_COLLECT')

    state = collectionPeriodReducer(state, { type: 'EDIT_REQUESTED' })
    expect(state).toEqual({
      draft,
      error: null,
      sourceId: 'source-upbit-1',
      status: 'PERIOD_EDITING',
    })
  })
})

describe('previewCollectionPeriodMock', () => {
  it('normalizes a tax year using the adapter-owned timezone', async () => {
    const controller = new AbortController()

    await expect(
      previewCollectionPeriodMock({
        period: {
          mode: 'TAX_YEAR',
          taxYear: '2027',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).resolves.toEqual({
      estimatedTransactionCount: 1_248,
      normalizedPeriod: {
        endDate: '2027-12-31',
        mode: 'TAX_YEAR',
        startDate: '2027-01-01',
        taxYear: '2027',
        timezone: 'Asia/Seoul',
      },
      ok: true,
      sourceCoverage: {
        endDate: '2027-12-31',
        startDate: '2027-01-01',
      },
      timezone: 'Asia/Seoul',
      warnings: [],
    })
  })

  it('rejects a tax year outside the server-provided allowlist', async () => {
    const controller = new AbortController()

    await expect(
      previewCollectionPeriodMock({
        period: {
          mode: 'TAX_YEAR',
          taxYear: '2025',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).resolves.toEqual({
      error: {
        code: 'INVALID_DATE_RANGE',
        fieldErrors: {
          taxYear: 'NOT_ALLOWED',
        },
        requestId: 'period-preview-mock-tax-year',
      },
      ok: false,
    })
  })

  it('uses the server-provided latest date to reject future periods', async () => {
    const controller = new AbortController()
    const previewPeriod = createPreviewCollectionPeriodMock({
      allowedTaxYears: ['2027'],
      latestAllowedDate: '2027-06-30',
      sourceCoverage: {
        endDate: '2027-12-31',
        startDate: '2027-01-01',
      },
      timezone: 'Asia/Seoul',
    })

    await expect(
      previewPeriod({
        period: {
          mode: 'TAX_YEAR',
          taxYear: '2027',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).resolves.toEqual({
      error: {
        code: 'INVALID_DATE_RANGE',
        fieldErrors: {
          taxYear: 'AFTER_LATEST_ALLOWED_DATE',
        },
        requestId: 'period-preview-mock-future',
      },
      ok: false,
    })

    await expect(
      previewPeriod({
        period: {
          endDate: '2027-07-01',
          mode: 'CUSTOM',
          startDate: '2027-06-01',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).resolves.toMatchObject({
      error: {
        code: 'INVALID_DATE_RANGE',
        fieldErrors: {
          endDate: 'AFTER_LATEST_ALLOWED_DATE',
        },
      },
      ok: false,
    })
  })

  it('returns exact missing ranges outside deterministic source coverage', async () => {
    const controller = new AbortController()
    const previewPeriod = createPreviewCollectionPeriodMock({
      allowedTaxYears: ['2028', '2027', '2026'],
      latestAllowedDate: '2028-12-31',
      sourceCoverage: {
        endDate: '2027-12-31',
        startDate: '2027-01-01',
      },
      timezone: 'Asia/Seoul',
    })

    await expect(
      previewPeriod({
        period: {
          endDate: '2028-01-31',
          mode: 'CUSTOM',
          startDate: '2026-12-01',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).resolves.toEqual({
      error: {
        code: 'SOURCE_COVERAGE_INSUFFICIENT',
        missingRanges: [
          {
            endDate: '2026-12-31',
            startDate: '2026-12-01',
          },
          {
            endDate: '2028-01-31',
            startDate: '2028-01-01',
          },
        ],
        requestId: 'period-preview-mock-coverage',
      },
      ok: false,
    })
  })

  it('uses the source context shown by the page for coverage and timezone', async () => {
    const previewPeriod = createPreviewCollectionPeriodMock({
      allowedTaxYears: ['2027'],
      latestAllowedDate: '2027-12-31',
      sourceCoverage: {
        endDate: '2027-10-20',
        startDate: '2027-03-10',
      },
      timezone: 'Asia/Tokyo',
    })
    const controller = new AbortController()

    await expect(
      previewPeriod({
        period: {
          endDate: '2027-10-21',
          mode: 'CUSTOM',
          startDate: '2027-03-09',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-context',
      }),
    ).resolves.toEqual({
      error: {
        code: 'SOURCE_COVERAGE_INSUFFICIENT',
        missingRanges: [
          {
            endDate: '2027-03-09',
            startDate: '2027-03-09',
          },
          {
            endDate: '2027-10-21',
            startDate: '2027-10-21',
          },
        ],
        requestId: 'period-preview-mock-coverage',
      },
      ok: false,
    })

    await expect(
      previewPeriod({
        period: {
          endDate: '2027-10-20',
          mode: 'CUSTOM',
          startDate: '2027-03-10',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-context',
      }),
    ).resolves.toMatchObject({
      normalizedPeriod: {
        endDate: '2027-10-20',
        startDate: '2027-03-10',
        timezone: 'Asia/Tokyo',
      },
      ok: true,
      sourceCoverage: {
        endDate: '2027-10-20',
        startDate: '2027-03-10',
      },
      timezone: 'Asia/Tokyo',
    })
  })

  it('rejects an already-aborted preview without returning a result', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      previewCollectionPeriodMock({
        period: {
          mode: 'TAX_YEAR',
          taxYear: '2027',
        },
        signal: controller.signal,
        sourceId: 'source-upbit-1',
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
