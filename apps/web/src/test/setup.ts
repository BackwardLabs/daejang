import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetSessionStateForTests } from '../auth/session-store.ts'

function createMemoryStorage(): Storage {
  const values = new Map<string, string>()

  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key) {
      return values.get(key) ?? null
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null
    },
    removeItem(key) {
      values.delete(key)
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
  }
}

Object.defineProperties(window, {
  localStorage: {
    configurable: true,
    value: createMemoryStorage(),
  },
  sessionStorage: {
    configurable: true,
    value: createMemoryStorage(),
  },
})

afterEach(() => {
  cleanup()
  resetSessionStateForTests()
  window.localStorage.clear()
  window.sessionStorage.clear()
})
