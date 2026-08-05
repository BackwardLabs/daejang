import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getSessionSnapshot, resetSessionStateForTests } from '../auth/session-store.ts'
import { AccountProfileDialog } from './AccountProfileDialog.tsx'

afterEach(() => {
  resetSessionStateForTests()
  vi.unstubAllGlobals()
})

describe('AccountProfileDialog', () => {
  it('saves a normalized nickname and refreshes the shared session user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        user: {
          id: '00000000-0000-4000-8000-000000000001',
          displayName: '새 닉네임',
          email: 'user@example.com',
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<AccountProfileDialog
      logoutError=""
      logoutPending={false}
      onClose={vi.fn()}
      onLogout={vi.fn()}
      user={{
        id: '00000000-0000-4000-8000-000000000001',
        displayName: 'GIWA 사용자',
        email: 'user@example.com',
      }}
    />)

    fireEvent.change(screen.getByLabelText('닉네임'), {
      target: { value: '  새   닉네임  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))

    expect(await screen.findByText('닉네임을 저장했습니다')).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/me',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ displayName: '새 닉네임' }),
      }),
    )
    expect(getSessionSnapshot().user?.displayName).toBe('새 닉네임')
  })

  it('keeps an invalid one-character nickname on the client', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<AccountProfileDialog
      logoutError=""
      logoutPending={false}
      onClose={vi.fn()}
      onLogout={vi.fn()}
      user={{
        id: '00000000-0000-4000-8000-000000000001',
        displayName: '기존 닉네임',
      }}
    />)

    fireEvent.change(screen.getByLabelText('닉네임'), { target: { value: 'A' } })
    fireEvent.click(screen.getByRole('button', { name: '저장' }))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('2자 이상 20자 이하'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
