import { requestApi } from './client.ts'

export type CurrentUser = { id: string; displayName: string }
export const loadCurrentUser = (signal?: AbortSignal) => requestApi<{ user: CurrentUser }>('/me', { signal })
export const logout = () => requestApi<void>('/auth/session', { method: 'DELETE' })

