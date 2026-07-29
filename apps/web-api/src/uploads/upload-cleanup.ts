import type { UploadCleanupResult, UploadStore } from './upload-store.js'

type UploadCleanupOptions = {
  store: UploadStore
  intervalMs?: number
  now?: () => Date
  onResult?: (result: UploadCleanupResult) => void
  onError?: (error: unknown) => void
}

export type UploadCleanupController = {
  runNow: () => Promise<void>
  stop: () => Promise<void>
}

export const startUploadCleanup = (
  options: UploadCleanupOptions,
): UploadCleanupController => {
  const intervalMs = options.intervalMs ?? 60_000
  const now = options.now ?? (() => new Date())
  let active: Promise<void> | undefined
  let stopped = false

  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (active) return active

    active = options.store.cleanupAbandoned(now())
      .then((result) => options.onResult?.(result))
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => {
        active = undefined
      })
    return active
  }

  const timer = setInterval(() => void runNow(), intervalMs)
  timer.unref()
  void runNow()

  return {
    runNow,
    stop: async () => {
      stopped = true
      clearInterval(timer)
      await active
    },
  }
}
