import { useSyncExternalStore } from 'react'
import {
  getCurrentUser,
  WebApiError,
  type AuthenticatedUser,
} from './api.ts'

export type SessionStatus =
  | 'unknown'
  | 'checking'
  | 'authenticated'
  | 'anonymous'
  | 'error'

export type SessionSnapshot = {
  status: SessionStatus
  user: AuthenticatedUser | null
}

const unknownSession: SessionSnapshot = {
  status: 'unknown',
  user: null,
}
let sessionSnapshot = unknownSession
let bootstrapPromise: Promise<SessionSnapshot> | undefined
let revision = 0
const listeners = new Set<() => void>()

function publishSession(snapshot: SessionSnapshot) {
  sessionSnapshot = snapshot
  listeners.forEach((listener) => listener())
}

export function setCurrentUser(user: AuthenticatedUser | null) {
  revision += 1
  publishSession({
    status: user ? 'authenticated' : 'anonymous',
    user,
  })
}

export function getCurrentUserSnapshot() {
  return sessionSnapshot.user
}

export function getSessionSnapshot() {
  return sessionSnapshot
}

export function getSessionRevision() {
  return revision
}

export function invalidateSessionAtRevision(expectedRevision: number) {
  if (
    revision !== expectedRevision ||
    sessionSnapshot.status !== 'authenticated'
  ) {
    return false
  }

  revision += 1
  bootstrapPromise = undefined
  publishSession({ status: 'anonymous', user: null })
  return true
}

export function bootstrapSession({ retry = false } = {}) {
  if (bootstrapPromise) return bootstrapPromise
  if (
    sessionSnapshot.status === 'authenticated' ||
    sessionSnapshot.status === 'anonymous' ||
    (sessionSnapshot.status === 'error' && !retry)
  ) {
    return Promise.resolve(sessionSnapshot)
  }

  const startRevision = revision
  publishSession({ status: 'checking', user: null })

  const request = getCurrentUser()
    .then(({ user }) => {
      if (revision !== startRevision) return sessionSnapshot

      revision += 1
      publishSession({ status: 'authenticated', user })
      return sessionSnapshot
    })
    .catch((caught: unknown) => {
      if (revision !== startRevision) return sessionSnapshot

      const authenticationRequired =
        caught instanceof WebApiError && caught.status === 401
      if (authenticationRequired) revision += 1
      publishSession({
        status: authenticationRequired ? 'anonymous' : 'error',
        user: null,
      })
      return sessionSnapshot
    })
    .finally(() => {
      if (bootstrapPromise === request) bootstrapPromise = undefined
    })

  bootstrapPromise = request
  return request
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCurrentUser() {
  return useSyncExternalStore(subscribe, getCurrentUserSnapshot, () => null)
}

export function useSession() {
  return useSyncExternalStore(
    subscribe,
    getSessionSnapshot,
    () => unknownSession,
  )
}

export function resetSessionStateForTests() {
  revision += 1
  bootstrapPromise = undefined
  publishSession(unknownSession)
}
