import { useSyncExternalStore } from 'react'
import type { AuthenticatedUser } from './api.ts'

let currentUser: AuthenticatedUser | null = null
const listeners = new Set<() => void>()

export function setCurrentUser(user: AuthenticatedUser | null) {
  currentUser = user
  listeners.forEach((listener) => listener())
}

export function getCurrentUserSnapshot() {
  return currentUser
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCurrentUser() {
  return useSyncExternalStore(subscribe, getCurrentUserSnapshot, () => null)
}
