import type { AuthenticatedUser } from '../auth/api.ts'
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
  const nickname =
    user?.displayName && user.displayName !== 'GIWA 사용자'
      ? user.displayName
      : undefined

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
      <dl className="app-dialog-profile">
        <div>
          <dt>로그인 이메일</dt>
          <dd>{user?.email ?? '등록된 이메일이 없습니다'}</dd>
        </div>
        <div>
          <dt>닉네임</dt>
          <dd>{nickname ?? '아직 설정하지 않았어요'}</dd>
          <span>닉네임 설정 기능은 추후 제공할 예정입니다</span>
        </div>
      </dl>
      {logoutError ? (
        <p className="app-dialog-profile__error" role="alert">
          {logoutError}
        </p>
      ) : null}
    </AppDialog>
  )
}
