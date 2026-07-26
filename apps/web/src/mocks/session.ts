export type MockAuthenticatedUser = {
  email: string
  id: string
  name: string
  role: 'owner'
}

export type MockAuthenticatedSession = {
  authenticatedAt: string
  isAuthenticated: true
  user: MockAuthenticatedUser
}

export const mockAuthenticatedSession: MockAuthenticatedSession = {
  isAuthenticated: true,
  authenticatedAt: '2027-07-20T09:00:00+09:00',
  user: {
    id: 'user_mock_01',
    name: '김대장',
    email: 'daejang@example.com',
    role: 'owner',
  },
}

export const mockSessionStorageKey = 'daejang.mock.authenticated'

export function isMockSessionAuthenticated() {
  if (typeof window === 'undefined') return true

  return window.sessionStorage.getItem(mockSessionStorageKey) !== 'false'
}

export function restoreMockSession() {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(mockSessionStorageKey, 'true')
  }
}

export function logoutMockSession() {
  if (typeof window !== 'undefined') {
    window.sessionStorage.setItem(mockSessionStorageKey, 'false')
  }
}
