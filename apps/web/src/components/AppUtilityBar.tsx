import { mockAuthenticatedSession } from '../mocks/session.ts'
import './app-utility-bar.css'

export function AppUtilityBar({
  currentPage,
  syncLabel = '방금 동기화',
  syncTone = 'positive',
  year,
}: {
  currentPage: string
  syncLabel?: string
  syncTone?: 'neutral' | 'positive'
  year: string
}) {
  const { user } = mockAuthenticatedSession

  return (
    <header className="app-utility-bar">
      <nav className="app-utility-bar__breadcrumb" aria-label="현재 위치">
        <a href="/app/dashboard">Daejang</a>
        <span aria-hidden="true">/</span>
        <strong>{currentPage}</strong>
      </nav>

      <div className="app-utility-bar__context">
        <span
          className={`app-utility-bar__sync app-utility-bar__sync--${syncTone}`}
        >
          <i aria-hidden="true" />
          {syncLabel}
        </span>
        <span className="app-utility-bar__year">{year} 과세연도</span>
        <span
          className="app-utility-bar__avatar"
          aria-label={`${user.name} 사용자`}
          role="img"
        />
      </div>
    </header>
  )
}
