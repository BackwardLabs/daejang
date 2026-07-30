export type AppYear = '2025' | '2026' | '2027'
export type AppCurrency = 'KRW'

export type AppPreferences = {
  currency: AppCurrency
  year: AppYear
}

type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

export const appPreferencesStorageKey = 'daejang-app-preferences.v1'

const supportedYears = new Set<AppYear>(['2025', '2026', '2027'])

const browserLocalStorage = (): PreferenceStorage | undefined => {
  if (typeof window === 'undefined') return undefined

  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export const defaultAppYear = (now = new Date()): AppYear => {
  const year = now.getFullYear()
  if (year <= 2025) return '2025'
  if (year >= 2027) return '2027'
  return '2026'
}

export const defaultAppPreferences = (now = new Date()): AppPreferences => ({
  currency: 'KRW',
  year: defaultAppYear(now),
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function normalizeAppPreferences(
  value: unknown,
  now = new Date(),
): AppPreferences {
  const defaults = defaultAppPreferences(now)
  if (!isRecord(value)) return defaults

  return {
    currency: value.currency === 'KRW' ? 'KRW' : defaults.currency,
    year:
      typeof value.year === 'string' &&
      supportedYears.has(value.year as AppYear)
        ? (value.year as AppYear)
        : defaults.year,
  }
}

export function loadAppPreferences(
  storage: Pick<Storage, 'getItem'> | undefined = browserLocalStorage(),
  now = new Date(),
): AppPreferences {
  if (!storage) return defaultAppPreferences(now)

  try {
    const stored = storage.getItem(appPreferencesStorageKey)
    if (!stored) return defaultAppPreferences(now)
    return normalizeAppPreferences(JSON.parse(stored), now)
  } catch {
    return defaultAppPreferences(now)
  }
}

export function saveAppPreferences(
  preferences: AppPreferences,
  storage: Pick<Storage, 'setItem'> | undefined = browserLocalStorage(),
): boolean {
  if (!storage) return false

  try {
    storage.setItem(
      appPreferencesStorageKey,
      JSON.stringify(normalizeAppPreferences(preferences)),
    )
    return true
  } catch {
    return false
  }
}

export function saveAppYear(
  year: AppYear,
  storage: PreferenceStorage | undefined = browserLocalStorage(),
): boolean {
  if (!storage) return false

  return saveAppPreferences(
    {
      ...loadAppPreferences(storage),
      year,
    },
    storage,
  )
}
