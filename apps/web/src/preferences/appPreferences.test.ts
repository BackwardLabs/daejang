import { describe, expect, it, vi } from 'vitest'
import {
  appPreferencesStorageKey,
  defaultAppPreferences,
  loadAppPreferences,
  saveAppPreferences,
  saveAppYear,
} from './appPreferences.ts'

const fixedNow = new Date('2026-07-31T00:00:00Z')

describe('app preferences', () => {
  it('uses the supported current year and KRW when nothing was stored', () => {
    expect(defaultAppPreferences(fixedNow)).toEqual({
      currency: 'KRW',
      year: '2026',
    })
    expect(
      loadAppPreferences({ getItem: () => null }, fixedNow),
    ).toEqual({
      currency: 'KRW',
      year: '2026',
    })
  })

  it('loads a validated browser-local preference', () => {
    expect(
      loadAppPreferences(
        {
          getItem: () =>
            JSON.stringify({ currency: 'KRW', year: '2025' }),
        },
        fixedNow,
      ),
    ).toEqual({ currency: 'KRW', year: '2025' })
  })

  it('falls back field-by-field for malformed or unsupported values', () => {
    expect(
      loadAppPreferences(
        {
          getItem: () =>
            JSON.stringify({ currency: 'USD', year: '2042' }),
        },
        fixedNow,
      ),
    ).toEqual({ currency: 'KRW', year: '2026' })
    expect(
      loadAppPreferences({ getItem: () => '{broken' }, fixedNow),
    ).toEqual({ currency: 'KRW', year: '2026' })
  })

  it('persists the normalized preference and preserves currency on year updates', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }

    expect(
      saveAppPreferences({ currency: 'KRW', year: '2027' }, storage),
    ).toBe(true)
    expect(JSON.parse(values.get(appPreferencesStorageKey) ?? '')).toEqual({
      currency: 'KRW',
      year: '2027',
    })

    expect(saveAppYear('2025', storage)).toBe(true)
    expect(loadAppPreferences(storage, fixedNow)).toEqual({
      currency: 'KRW',
      year: '2025',
    })
  })

  it('reports storage write failures instead of claiming a save', () => {
    const setItem = vi.fn(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    expect(
      saveAppPreferences(
        { currency: 'KRW', year: '2027' },
        { setItem },
      ),
    ).toBe(false)
  })
})
