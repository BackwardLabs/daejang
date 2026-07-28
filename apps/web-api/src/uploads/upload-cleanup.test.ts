import { afterEach, describe, expect, it, vi } from 'vitest'

import { startUploadCleanup } from './upload-cleanup.js'
import type { UploadCleanupResult, UploadStore } from './upload-store.js'

const emptyResult = (): UploadCleanupResult => ({
  examined: 0,
  removed: 0,
  missing: 0,
  retryPending: 0,
})

const storeWithCleanup = (
  cleanupAbandoned: UploadStore['cleanupAbandoned'],
): UploadStore => ({
  durable: true,
  create: vi.fn(async () => { throw new Error('not used') }),
  write: vi.fn(async () => undefined),
  confirm: vi.fn(async () => undefined),
  discard: vi.fn(async () => false),
  cleanupAbandoned,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startUploadCleanup', () => {
  it('runs immediately and never overlaps periodic sweeps', async () => {
    vi.useFakeTimers()
    let completeFirst!: (result: UploadCleanupResult) => void
    const first = new Promise<UploadCleanupResult>((resolve) => {
      completeFirst = resolve
    })
    const cleanupAbandoned = vi.fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue(emptyResult())
    const controller = startUploadCleanup({
      store: storeWithCleanup(cleanupAbandoned),
      intervalMs: 1_000,
    })

    expect(cleanupAbandoned).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(cleanupAbandoned).toHaveBeenCalledTimes(1)

    completeFirst(emptyResult())
    await controller.runNow()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(cleanupAbandoned).toHaveBeenCalledTimes(2)
    await controller.stop()
  })

  it('clears its timer and waits for an active sweep during shutdown', async () => {
    vi.useFakeTimers()
    let complete!: (result: UploadCleanupResult) => void
    const active = new Promise<UploadCleanupResult>((resolve) => {
      complete = resolve
    })
    const cleanupAbandoned = vi.fn(async () => active)
    const controller = startUploadCleanup({
      store: storeWithCleanup(cleanupAbandoned),
      intervalMs: 1_000,
    })
    let stopped = false
    const stopping = controller.stop().then(() => {
      stopped = true
    })

    await Promise.resolve()
    expect(stopped).toBe(false)
    complete(emptyResult())
    await stopping
    expect(stopped).toBe(true)

    await vi.advanceTimersByTimeAsync(5_000)
    await controller.runNow()
    expect(cleanupAbandoned).toHaveBeenCalledTimes(1)
  })
})
