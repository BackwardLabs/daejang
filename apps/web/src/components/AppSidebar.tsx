import navDashboard from '../assets/dashboard/nav-dashboard.svg'
import navLedger from '../assets/dashboard/nav-ledger.svg'
import navReport from '../assets/dashboard/nav-report.svg'
import navSettings from '../assets/dashboard/nav-settings.svg'
import navSources from '../assets/dashboard/nav-sources.svg'
import userAvatar from '../assets/dashboard/user-avatar.svg'
import { logout } from '../auth/api.ts'
import { setCurrentUser, useCurrentUser } from '../auth/session-store.ts'
import { Fragment, useEffect, useRef, useState } from 'react'
import './app-sidebar.css'

export type AppPage = 'dashboard' | 'ledger' | 'reports' | 'settings' | 'sources'
export type AppYear = '2026' | '2027'

export type AppSidebarSecondaryItem = {
  badge?: string
  disabled?: boolean
  disabledReason?: string
  id: string
  label: string
}

const navigation: Array<{
  badge?: string
  href: string
  icon: string
  label: string
  page: AppPage
}> = [
  { icon: navDashboard, label: '대시보드', href: '/dashboard', page: 'dashboard' },
  {
    icon: navLedger,
    label: '장부 작업',
    href: '/ledger',
    page: 'ledger',
  },
  { icon: navReport, label: '보고서', href: '/reports', page: 'reports' },
  { icon: navSources, label: '거래소·지갑', href: '/sources', page: 'sources' },
  { icon: navSettings, label: '설정', href: '/settings', page: 'settings' },
]

export function AppSidebar({
  activePage,
  activeSecondaryItem,
  onSecondarySelect,
  onYearChange,
  secondaryItems = [],
  year,
}: {
  activePage: AppPage
  activeSecondaryItem?: string
  onSecondarySelect?: (id: string) => void
  onYearChange: (year: AppYear) => void
  secondaryItems?: AppSidebarSecondaryItem[]
  year: AppYear
}) {
  const user = useCurrentUser()
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const userMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isUserMenuOpen) return

    function closeUserMenu(event: MouseEvent) {
      if (
        event.target instanceof Node &&
        !userMenuRef.current?.contains(event.target)
      ) {
        setIsUserMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', closeUserMenu)
    return () => document.removeEventListener('mousedown', closeUserMenu)
  }, [isUserMenuOpen])

  async function handleLogout() {
    setLogoutPending(true)
    setLogoutError('')
    try {
      await logout()
      setCurrentUser(null)
      window.history.replaceState({}, '', '/login')
      window.dispatchEvent(new PopStateEvent('popstate'))
    } catch {
      setLogoutError('로그아웃하지 못했습니다')
    } finally {
      setLogoutPending(false)
    }
  }

  return (
    <aside className="app-sidebar">
      <a className="app-sidebar__brand" href="/" aria-label="Daejang 소개 페이지로 이동">
        <img src="/daejang-logo.svg" alt="" />
        <span>Daejang</span>
      </a>

      <label className="app-sidebar__period">
        <span className="sr-only">조회 기간</span>
        <select
          value={year}
          onChange={(event) => onYearChange(event.target.value as AppYear)}
        >
          <option value="2027">2027년 · 전체 기간</option>
          <option value="2026">2026년 · 전체 기간</option>
        </select>
      </label>

      <nav aria-label="제품 메뉴">
        <ul className="app-sidebar__navigation">
          {navigation.map((item) => {
            const isActive = item.page === activePage
            const hasSecondaryItems =
              item.page === 'ledger' && secondaryItems.length > 0

            return (
              <Fragment key={item.page}>
                <li className={isActive ? 'is-active' : undefined}>
                  <a
                    href={item.href}
                    aria-current={isActive ? 'page' : undefined}
                    aria-expanded={hasSecondaryItems ? true : undefined}
                  >
                    <img src={item.icon} alt="" />
                    <span>{item.label}</span>
                    {item.badge && (
                      <b aria-hidden="true" className="app-sidebar__nav-badge">
                        {item.badge}
                      </b>
                    )}
                  </a>
                </li>
                {hasSecondaryItems && (
                  <li className="app-sidebar__secondary-row">
                  <nav
                    className="app-sidebar__secondary"
                    aria-label="장부 작업 메뉴"
                  >
                    {secondaryItems.map((secondaryItem) => {
                      const isSecondaryActive =
                        secondaryItem.id === activeSecondaryItem

                      return (
                        <button
                          key={secondaryItem.id}
                          type="button"
                          disabled={secondaryItem.disabled}
                          title={secondaryItem.disabledReason}
                          className={
                            isSecondaryActive ? 'is-active' : undefined
                          }
                          onClick={() =>
                            onSecondarySelect?.(secondaryItem.id)
                          }
                        >
                          <span>{secondaryItem.label}</span>
                          {secondaryItem.badge && <b>{secondaryItem.badge}</b>}
                        </button>
                      )
                    })}
                  </nav>
                  </li>
                )}
              </Fragment>
            )
          })}
        </ul>
      </nav>

      <a className="app-sidebar__guide" href="/ledger">
        <strong>처음 사용하시나요?</strong>
        <span>장부 만들기 가이드를 확인하세요.</span>
      </a>

      <div className="app-sidebar__user-area" ref={userMenuRef}>
        {isUserMenuOpen && (
          <div className="app-sidebar__user-menu" role="menu">
            <div>
              <strong>{user?.displayName || '계정'}</strong>
              <span>개인 장부 계정</span>
            </div>
            {logoutError ? <p role="alert">{logoutError}</p> : null}
            <button
              type="button"
              role="menuitem"
              disabled={logoutPending}
              onClick={handleLogout}
            >
              {logoutPending ? '로그아웃 중' : '로그아웃'}
            </button>
          </div>
        )}
        <button
          type="button"
          className="app-sidebar__user"
          aria-expanded={isUserMenuOpen}
          aria-haspopup="menu"
          onClick={() => setIsUserMenuOpen((value) => !value)}
        >
          <img src={userAvatar} alt="" />
          <span>
            <strong>{user?.displayName || '계정'}</strong>
            <small>개인 장부</small>
          </span>
          <i aria-hidden="true">⌃</i>
        </button>
      </div>
    </aside>
  )
}
