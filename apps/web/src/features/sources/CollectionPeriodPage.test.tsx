import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollectionPeriodPage } from './CollectionPeriodPage.tsx'
import type {
  CollectionPeriodPreviewResult,
  CollectionPeriodPreviewSuccess,
  LoadCollectionPeriodSource,
  LoadCollectionPeriodSourceResult,
  PreviewCollectionPeriod,
} from './collectionPeriod.ts'

const fullSourceContext = {
  coverage: {
    endDate: '2027-12-31',
    startDate: '2027-01-01',
  },
  timezone: 'Asia/Seoul',
}

function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })

  return {
    promise,
    resolve: resolvePromise,
  }
}

function storedText(storage: Storage) {
  return Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index)
    return key ? `${key}:${storage.getItem(key)}` : ''
  }).join('|')
}

function taxYearPreview(
  sourceCoverage = {
    endDate: '2027-12-31',
    startDate: '2027-01-01',
  },
): CollectionPeriodPreviewSuccess {
  return {
    estimatedTransactionCount: 1_248,
    normalizedPeriod: {
      endDate: '2027-12-31',
      mode: 'TAX_YEAR',
      startDate: '2027-01-01',
      taxYear: '2027',
      timezone: 'Asia/Seoul',
    },
    ok: true,
    sourceCoverage,
    timezone: 'Asia/Seoul',
    warnings: [],
  }
}

afterEach(() => {
  window.history.pushState({}, '', '/')
})

describe('CollectionPeriodPage', () => {
  it('shows the saved source, coverage, timezone, and persistent state labels initially', () => {
    render(
      <CollectionPeriodPage
        sourceId="source-upbit-persisted"
        sourceContext={{
          coverage: {
            endDate: '2027-11-30',
            startDate: '2027-02-01',
          },
          timezone: 'Asia/Seoul',
        }}
      />,
    )

    expect(
      screen.getByRole('heading', { name: '조회 기간 설정' }),
    ).toBeInTheDocument()
    expect(screen.getByText('PERIOD EDITING')).toBeInTheDocument()
    expect(screen.getByText('저장 완료')).toBeInTheDocument()
    expect(screen.getByText('문서 포함 범위')).toBeInTheDocument()
    expect(screen.getAllByText('기준 시간대')).toHaveLength(2)
    expect(screen.getByText('source-upbit-persisted')).toBeInTheDocument()
    expect(
      screen.getAllByText('2027.02.01 – 2027.11.30'),
    ).toHaveLength(2)
    expect(screen.getAllByText('Asia/Seoul')).toHaveLength(2)
    expect(
      screen.getByRole('combobox', { name: '과세연도' }),
    ).toHaveValue('2027')
    expect(screen.getByLabelText('시작일')).toHaveValue('2027-01-01')
    expect(screen.getByLabelText('종료일')).toHaveValue('2027-12-31')
  })

  it('falls back to a server-allowed tax year when switching from custom dates', () => {
    render(
      <CollectionPeriodPage
        sourceContext={{
          coverage: {
            endDate: '2027-12-31',
            startDate: '2026-01-01',
          },
          periodLimits: {
            latestAllowedDate: '2027-12-31',
            taxYears: ['2026'],
          },
          timezone: 'Asia/Seoul',
        }}
        sourceId="source-upbit-tax-year-limits"
      />,
    )

    fireEvent.click(
      screen.getByRole('radio', { name: '직접 기간 설정' }),
    )
    fireEvent.change(screen.getByLabelText('시작일'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: '2027-06-30' },
    })
    fireEvent.click(
      screen.getByRole('radio', { name: '과세연도 전체' }),
    )

    expect(
      screen.getByRole('combobox', { name: '과세연도' }),
    ).toHaveValue('2026')
    expect(screen.getByLabelText('시작일')).toHaveValue('2026-01-01')
    expect(screen.getByLabelText('종료일')).toHaveValue('2026-12-31')
  })

  it('does not expose source details until the current account source is resolved', async () => {
    const deferred = createDeferred<LoadCollectionPeriodSourceResult>()
    let submittedSignal: AbortSignal | undefined
    const loadSourceContext: LoadCollectionPeriodSource = vi.fn(
      ({ signal }) => {
        submittedSignal = signal
        return deferred.promise
      },
    )

    render(
      <CollectionPeriodPage
        loadSourceContext={loadSourceContext}
        sourceId="source-upbit-authorized"
      />,
    )

    expect(
      screen.getByRole('heading', {
        name: '등록한 데이터 소스를 확인 중입니다',
      }),
    ).toBeInTheDocument()
    expect(screen.queryByText('저장 완료')).not.toBeInTheDocument()
    expect(screen.queryByText('문서 포함 범위')).not.toBeInTheDocument()
    expect(screen.getAllByText('데이터 소스 확인')).toHaveLength(2)
    expect(
      screen.queryByRole('navigation', {
        name: '데이터 수집 준비 단계',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: '과세연도' }),
    ).not.toBeInTheDocument()
    expect(submittedSignal?.aborted).toBe(false)

    await act(async () => {
      deferred.resolve({
        context: {
          coverage: {
            endDate: '2027-11-30',
            startDate: '2027-02-01',
          },
          periodLimits: {
            latestAllowedDate: '2027-12-31',
            taxYears: ['2027', '2026'],
          },
          sourceId: 'source-upbit-authorized',
          sourceStatus: 'SOURCE_SAVED',
          sourceType: 'UPBIT_PDF',
          timezone: 'Asia/Seoul',
        },
        ok: true,
      })
      await deferred.promise
    })

    expect(screen.getByText('저장 완료')).toBeInTheDocument()
    expect(screen.getByText('문서 포함 범위')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', {
        name: '데이터 수집 준비 단계',
      }),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText('2027.02.01 – 2027.11.30'),
    ).toHaveLength(2)
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
    expect(
      screen.getByRole('heading', {
        name: '조회 기간과 문서 범위를 확인하세요',
      }),
    ).toHaveFocus()
  })

  it('shows the same safe recovery UI when source context is unavailable', async () => {
    const loadSourceContext: LoadCollectionPeriodSource = vi.fn(
      async (): Promise<LoadCollectionPeriodSourceResult> => {
        return {
          error: {
            code: 'SOURCE_CONTEXT_UNAVAILABLE',
            requestId: 'period-source-safe-1',
          },
          ok: false,
        }
      },
    )

    render(
      <CollectionPeriodPage
        loadSourceContext={loadSourceContext}
        sourceId="missing-or-other-workspace"
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('데이터 소스를 확인할 수 없어요')
    expect(alert).toHaveTextContent(
      '요청한 데이터 소스가 없거나 현재 계정에서 사용할 수 없습니다.',
    )
    expect(alert).toHaveTextContent('period-source-safe-1')
    expect(
      screen.getByRole('link', { name: '새 데이터 소스 등록' }),
    ).toHaveAttribute('href', '/sources/new')
    expect(screen.queryByText('저장 완료')).not.toBeInTheDocument()
    expect(screen.queryByText('문서 포함 범위')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('navigation', {
        name: '데이터 수집 준비 단계',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '조회 범위 확인' }),
    ).not.toBeInTheDocument()
  })

  it('rejects a successful context that belongs to a different source without leaking it', async () => {
    const loadSourceContext: LoadCollectionPeriodSource = vi.fn(
      async (): Promise<LoadCollectionPeriodSourceResult> => ({
        context: {
          coverage: {
            endDate: '2031-12-31',
            startDate: '2031-01-01',
          },
          periodLimits: {
            latestAllowedDate: '2031-12-31',
            taxYears: ['2031'],
          },
          sourceId: 'source-from-other-request',
          sourceStatus: 'SOURCE_SAVED',
          sourceType: 'UPBIT_PDF',
          timezone: 'Sensitive/Workspace',
        },
        ok: true,
      }),
    )

    render(
      <CollectionPeriodPage
        loadSourceContext={loadSourceContext}
        sourceId="source-from-route"
      />,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '데이터 소스를 확인할 수 없어요',
    )
    expect(document.body).not.toHaveTextContent(
      'source-from-other-request',
    )
    expect(document.body).not.toHaveTextContent('Sensitive/Workspace')
    expect(document.body).not.toHaveTextContent(
      '2031.01.01 – 2031.12.31',
    )
  })

  it('offers retry for a transient source load failure and then restores the editor', async () => {
    let calls = 0
    const loadSourceContext: LoadCollectionPeriodSource = vi.fn(
      async ({ sourceId }): Promise<LoadCollectionPeriodSourceResult> => {
        calls += 1
        if (calls === 1) {
          throw new Error('temporary network failure')
        }

        return {
          context: {
            coverage: {
              endDate: '2027-12-31',
              startDate: '2027-01-01',
            },
            periodLimits: {
              latestAllowedDate: '2027-12-31',
              taxYears: ['2027', '2026'],
            },
            sourceId,
            sourceStatus: 'SOURCE_SAVED',
            sourceType: 'UPBIT_PDF',
            timezone: 'Asia/Seoul',
          },
          ok: true,
        }
      },
    )

    render(
      <CollectionPeriodPage
        loadSourceContext={loadSourceContext}
        sourceId="source-upbit-retry"
      />,
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('데이터 소스를 불러오지 못했어요')
    expect(
      screen.queryByRole('link', { name: '새 데이터 소스 등록' }),
    ).not.toBeInTheDocument()

    fireEvent.click(
      screen.getByRole('button', { name: '다시 확인' }),
    )

    expect(
      await screen.findByText('source-upbit-retry'),
    ).toBeInTheDocument()
    expect(loadSourceContext).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
  })

  it('aborts the source lookup when the period page unmounts', async () => {
    let submittedSignal: AbortSignal | undefined
    let sourcePromise:
      | Promise<LoadCollectionPeriodSourceResult>
      | undefined
    const loadSourceContext: LoadCollectionPeriodSource = vi.fn(
      ({ signal }) => {
        submittedSignal = signal
        sourcePromise = new Promise<LoadCollectionPeriodSourceResult>(
          (_, reject) => {
            signal.addEventListener(
              'abort',
              () => {
                reject(
                  new DOMException(
                    'The source lookup was aborted.',
                    'AbortError',
                  ),
                )
              },
              { once: true },
            )
          },
        )
        return sourcePromise
      },
    )

    const { unmount } = render(
      <CollectionPeriodPage
        loadSourceContext={loadSourceContext}
        sourceId="source-upbit-leaving"
      />,
    )

    expect(submittedSignal?.aborted).toBe(false)
    await act(async () => {
      unmount()
      await sourcePromise?.catch(() => undefined)
    })
    expect(submittedSignal?.aborted).toBe(true)
  })

  it('submits a TAX_YEAR preview request and renders the READY result', async () => {
    let submittedRequest:
      | Parameters<PreviewCollectionPeriod>[0]
      | undefined
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      async (request: Parameters<PreviewCollectionPeriod>[0]) => {
        submittedRequest = request
        return taxYearPreview()
      },
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-tax-year"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).toBeInTheDocument()
    expect(previewPeriod).toHaveBeenCalledTimes(1)
    expect(submittedRequest).toMatchObject({
      period: {
        mode: 'TAX_YEAR',
        taxYear: '2027',
      },
      sourceId: 'source-upbit-tax-year',
    })
    expect(submittedRequest?.signal.aborted).toBe(false)
    expect(screen.getByText('READY TO COLLECT')).toBeInTheDocument()
    expect(
      screen.getByText('Upbit · source-upbit-tax-year'),
    ).toBeInTheDocument()
    expect(
      screen.getAllByText('2027.01.01 – 2027.12.31').length,
    ).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('약 1,248건')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '수집 시작' }),
    ).toBeDisabled()
  })

  it('sends exact CUSTOM dates without putting them in URL or browser storage', async () => {
    const startDate = '2027-03-14'
    const endDate = '2027-10-22'
    let submittedRequest:
      | Parameters<PreviewCollectionPeriod>[0]
      | undefined
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      async (request: Parameters<PreviewCollectionPeriod>[0]) => {
        submittedRequest = request
        return {
          estimatedTransactionCount: 381,
          normalizedPeriod: {
            endDate,
            mode: 'CUSTOM',
            startDate,
            timezone: 'Asia/Seoul',
          },
          ok: true,
          sourceCoverage: {
            endDate: '2027-12-31',
            startDate: '2027-01-01',
          },
          timezone: 'Asia/Seoul',
          warnings: [],
        } satisfies CollectionPeriodPreviewResult
      },
    )
    window.history.pushState(
      {},
      '',
      '/sources/source-upbit-private/period?view=edit#range',
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-private"
      />,
    )

    fireEvent.click(
      screen.getByRole('radio', { name: '직접 기간 설정' }),
    )
    fireEvent.change(screen.getByLabelText('시작일'), {
      target: { value: startDate },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: endDate },
    })

    expect(window.location.href).not.toContain(startDate)
    expect(window.location.href).not.toContain(endDate)
    expect(storedText(window.localStorage)).not.toContain(startDate)
    expect(storedText(window.localStorage)).not.toContain(endDate)
    expect(storedText(window.sessionStorage)).not.toContain(startDate)
    expect(storedText(window.sessionStorage)).not.toContain(endDate)

    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).toBeInTheDocument()
    expect(previewPeriod).toHaveBeenCalledTimes(1)
    expect(submittedRequest).toMatchObject({
      period: {
        endDate,
        mode: 'CUSTOM',
        startDate,
      },
      sourceId: 'source-upbit-private',
    })
    expect(screen.getByText('2027.03.14 – 2027.10.22')).toBeInTheDocument()
    expect(window.location.href).not.toContain(startDate)
    expect(window.location.href).not.toContain(endDate)
    expect(storedText(window.localStorage)).not.toContain(startDate)
    expect(storedText(window.localStorage)).not.toContain(endDate)
    expect(storedText(window.sessionStorage)).not.toContain(startDate)
    expect(storedText(window.sessionStorage)).not.toContain(endDate)
  })

  it('keeps invalid custom values, focuses the first invalid field, and never calls the adapter', async () => {
    const previewPeriod: PreviewCollectionPeriod = vi.fn(async () =>
      taxYearPreview(),
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-invalid"
      />,
    )

    fireEvent.click(
      screen.getByRole('radio', { name: '직접 기간 설정' }),
    )
    const startDateInput = screen.getByLabelText('시작일')
    const endDateInput = screen.getByLabelText('종료일')
    fireEvent.change(startDateInput, {
      target: { value: '2027-09-02' },
    })
    fireEvent.change(endDateInput, {
      target: { value: '2027-09-01' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '조회 기간을 확인해 주세요',
    )
    expect(previewPeriod).not.toHaveBeenCalled()
    expect(startDateInput).toHaveValue('2027-09-02')
    expect(endDateInput).toHaveValue('2027-09-01')
    expect(startDateInput).toHaveAttribute('aria-invalid', 'true')
    expect(endDateInput).toHaveAttribute('aria-invalid', 'true')
    await waitFor(() => expect(startDateInput).toHaveFocus())
  })

  it('shows missing coverage while retaining the source and blocks collection until the period is edited', async () => {
    const previewPeriod: PreviewCollectionPeriod = vi.fn(async () => ({
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
        requestId: 'period-preview-coverage-1',
      },
      ok: false,
    } satisfies CollectionPeriodPreviewResult))

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-coverage"
      />,
    )

    fireEvent.click(
      screen.getByRole('radio', { name: '직접 기간 설정' }),
    )
    fireEvent.change(screen.getByLabelText('시작일'), {
      target: { value: '2026-12-01' },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: '2028-01-31' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(
      'PDF가 선택 기간 전체를 포함하지 않아요',
    )
    expect(alert).toHaveTextContent('2026.12.01 – 2026.12.31')
    expect(alert).toHaveTextContent('2028.01.01 – 2028.01.31')
    expect(alert).toHaveTextContent('period-preview-coverage-1')
    expect(
      screen.getByRole('link', { name: '다른 PDF 등록' }),
    ).toHaveAttribute('href', '/sources/new/upbit/upload')
    expect(alert).toHaveTextContent(
      '다른 PDF를 등록해도 현재 데이터 소스는 삭제되지 않습니다.',
    )
    expect(screen.getByText('source-upbit-coverage')).toBeInTheDocument()
    expect(screen.getByLabelText('시작일')).toHaveValue('2026-12-01')
    expect(screen.getByLabelText('종료일')).toHaveValue('2028-01-31')
    expect(screen.queryByRole('button', { name: /수집 시작/ })).not
      .toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('시작일'), {
      target: { value: '2027-01-01' },
    })
    fireEvent.change(screen.getByLabelText('종료일'), {
      target: { value: '2027-12-31' },
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByText('source-upbit-coverage')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
    expect(screen.queryByRole('button', { name: /수집 시작/ })).not
      .toBeInTheDocument()
  })

  it('renders only stable warning copy and an unavailable estimate state', async () => {
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      async (): Promise<CollectionPeriodPreviewResult> => ({
        ...taxYearPreview(),
        estimatedTransactionCount: null,
        warnings: [
          { code: 'ESTIMATED_TRANSACTION_COUNT_UNAVAILABLE' },
          { code: 'REVIEW_RECOMMENDED' },
        ],
      }),
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-warning"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    expect(
      await screen.findByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('계산 중')).toBeInTheDocument()
    expect(
      screen.getByText(
        '예상 거래 건수를 아직 계산할 수 없습니다. 실제 수집 전에 기간과 데이터 소스를 한 번 더 확인해 주세요.',
      ),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        '수집 시작 전에 선택한 기간과 데이터 소스 정보를 한 번 더 확인해 주세요.',
      ),
    ).toBeInTheDocument()
    expect(window.location.href).not.toContain('1,248')
    expect(storedText(window.localStorage)).not.toContain('1,248')
    expect(storedText(window.sessionStorage)).not.toContain('1,248')
  })

  it('deduplicates a pending preview and aborts it when the user cancels', async () => {
    const deferred =
      createDeferred<CollectionPeriodPreviewResult>()
    let submittedSignal: AbortSignal | undefined
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      ({ signal }: Parameters<PreviewCollectionPeriod>[0]) => {
        submittedSignal = signal
        return deferred.promise
      },
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-pending"
      />,
    )

    const previewButton = screen.getByRole('button', {
      name: '조회 범위 확인',
    })
    fireEvent.click(previewButton)
    fireEvent.click(previewButton)

    expect(previewPeriod).toHaveBeenCalledTimes(1)
    expect(submittedSignal?.aborted).toBe(false)
    expect(
      screen.getByText('조회 범위와 예상 거래 건수를 확인하고 있어요'),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '확인 중…' }),
    ).toBeDisabled()

    fireEvent.click(
      screen.getByRole('button', { name: '확인 취소' }),
    )

    expect(submittedSignal?.aborted).toBe(true)
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
    expect(
      screen.queryByText('조회 범위와 예상 거래 건수를 확인하고 있어요'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('combobox', { name: '과세연도' }),
    ).toHaveValue('2027')

    await act(async () => {
      deferred.resolve(taxYearPreview())
      await deferred.promise
    })

    expect(
      screen.queryByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
  })

  it('invalidates a pending preview when the same source context is refreshed', async () => {
    const deferred = createDeferred<CollectionPeriodPreviewResult>()
    let submittedSignal: AbortSignal | undefined
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      ({ signal }: Parameters<PreviewCollectionPeriod>[0]) => {
        submittedSignal = signal
        return deferred.promise
      },
    )
    const { rerender } = render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-refresh"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )
    expect(submittedSignal?.aborted).toBe(false)

    rerender(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={{
          coverage: {
            endDate: '2027-11-30',
            startDate: '2027-02-01',
          },
          timezone: 'Asia/Tokyo',
        }}
        sourceId="source-upbit-refresh"
      />,
    )

    await waitFor(() => expect(submittedSignal?.aborted).toBe(true))
    expect(
      screen.getAllByText('2027.02.01 – 2027.11.30'),
    ).toHaveLength(2)
    expect(screen.getAllByText('Asia/Tokyo')).toHaveLength(2)
    expect(
      screen.queryByText('조회 범위와 예상 거래 건수를 확인하고 있어요'),
    ).not.toBeInTheDocument()

    await act(async () => {
      deferred.resolve(taxYearPreview())
      await deferred.promise
    })

    expect(
      screen.queryByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    ).toBeEnabled()
  })

  it('keeps a retry result when the cancelled request resolves later', async () => {
    const first = createDeferred<CollectionPeriodPreviewResult>()
    const second = createDeferred<CollectionPeriodPreviewResult>()
    const signals: AbortSignal[] = []
    const previewPeriod: PreviewCollectionPeriod = vi.fn(
      ({ signal }: Parameters<PreviewCollectionPeriod>[0]) => {
        signals.push(signal)
        return signals.length === 1 ? first.promise : second.promise
      },
    )

    render(
      <CollectionPeriodPage
        previewPeriod={previewPeriod}
        sourceContext={fullSourceContext}
        sourceId="source-upbit-retry-order"
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '확인 취소' }),
    )
    fireEvent.click(
      screen.getByRole('button', { name: '조회 범위 확인' }),
    )

    expect(previewPeriod).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    await act(async () => {
      second.resolve(taxYearPreview())
      await second.promise
    })
    expect(
      screen.getByRole('heading', {
        name: '조회 기간 확인이 끝났어요',
      }),
    ).toBeInTheDocument()
    expect(screen.getByText('약 1,248건')).toBeInTheDocument()

    await act(async () => {
      first.resolve({
        ...taxYearPreview(),
        estimatedTransactionCount: 9_999,
      })
      await first.promise
    })

    expect(screen.getByText('약 1,248건')).toBeInTheDocument()
    expect(screen.queryByText('약 9,999건')).not.toBeInTheDocument()
  })
})
