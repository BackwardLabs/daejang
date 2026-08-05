import { useEffect, useState } from 'react'
import type { AuthenticatedUser } from '../auth/api.ts'
import {
  updateCurrentUserDisplayName,
  WebApiError,
} from '../auth/api.ts'
import { setCurrentUser } from '../auth/session-store.ts'
import { AppDialog } from './AppDialog.tsx'

export function AccountProfileDialog({
  logoutError,
  logoutPending,
  onClose,
  onLogout,
  user,
}: {
  logoutError: string
  logoutPending: boolean
  onClose: () => void
  onLogout: () => void
  user: AuthenticatedUser | null
}) {
  const initialNickname =
    user?.displayName && user.displayName !== 'GIWA 사용자'
      ? user.displayName
      : ''
  const [nickname, setNickname] = useState(initialNickname)
  const [nicknameStatus, setNicknameStatus] = useState<
    'idle' | 'saving' | 'success' | 'error'
  >('idle')
  const [nicknameMessage, setNicknameMessage] = useState('')

  useEffect(() => {
    setNickname(initialNickname)
    setNicknameStatus('idle')
    setNicknameMessage('')
  }, [initialNickname, user?.id])

  const saveNickname = async () => {
    const normalized = nickname.normalize('NFC').trim().replace(/\s+/gu, ' ')
    const length = [...normalized].length
    if (length < 2 || length > 20) {
      setNicknameStatus('error')
      setNicknameMessage('닉네임은 2자 이상 20자 이하로 입력해 주세요')
      return
    }

    setNicknameStatus('saving')
    setNicknameMessage('')
    try {
      const response = await updateCurrentUserDisplayName(normalized)
      setCurrentUser(response.user)
      setNickname(response.user.displayName)
      setNicknameStatus('success')
      setNicknameMessage('닉네임을 저장했습니다')
    } catch (error) {
      setNicknameStatus('error')
      setNicknameMessage(
        error instanceof WebApiError
          ? error.message
          : '닉네임을 저장하지 못했습니다. 다시 시도해 주세요',
      )
    }
  }

  return (
    <AppDialog
      description="계정 정보와 개인 설정을 확인합니다"
      footer={
        <>
          <button
            data-variant="danger"
            disabled={logoutPending}
            type="button"
            onClick={onLogout}
          >
            {logoutPending ? '로그아웃 중' : '로그아웃'}
          </button>
          <button data-variant="primary" type="button" onClick={onClose}>
            확인
          </button>
        </>
      }
      onClose={onClose}
      size="compact"
      title="마이페이지"
    >
      <div className="app-dialog-profile">
        <div>
          <span className="app-dialog-profile__label">로그인 이메일</span>
          <strong>{user?.email ?? '등록된 이메일이 없습니다'}</strong>
        </div>
        <form
          className="app-dialog-profile__nickname"
          onSubmit={(event) => {
            event.preventDefault()
            void saveNickname()
          }}
        >
          <label htmlFor="account-nickname">닉네임</label>
          <div>
            <input
              id="account-nickname"
              autoComplete="nickname"
              disabled={nicknameStatus === 'saving'}
              maxLength={20}
              placeholder="사용할 닉네임을 입력해 주세요"
              value={nickname}
              onChange={(event) => {
                setNickname(event.target.value)
                setNicknameStatus('idle')
                setNicknameMessage('')
              }}
            />
            <button
              type="submit"
              disabled={
                nicknameStatus === 'saving' ||
                nickname.trim() === initialNickname
              }
            >
              {nicknameStatus === 'saving' ? '저장 중' : '저장'}
            </button>
          </div>
          <small>2자 이상 20자 이하로 입력할 수 있습니다</small>
          {nicknameMessage ? (
            <p
              className={`app-dialog-profile__message app-dialog-profile__message--${nicknameStatus}`}
              role={nicknameStatus === 'error' ? 'alert' : 'status'}
            >
              {nicknameMessage}
            </p>
          ) : null}
        </form>
      </div>
      {logoutError ? (
        <p className="app-dialog-profile__error" role="alert">
          {logoutError}
        </p>
      ) : null}
    </AppDialog>
  )
}
