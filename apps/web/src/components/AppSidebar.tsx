import navDashboard from '../assets/dashboard/nav-dashboard.svg'
import navLedger from '../assets/dashboard/nav-ledger.svg'
import navReport from '../assets/dashboard/nav-report.svg'
import navSettings from '../assets/dashboard/nav-settings.svg'
import navSources from '../assets/dashboard/nav-sources.svg'
import userAvatar from '../assets/dashboard/user-avatar.svg'
import {
  logoutMockSession,
  mockAuthenticatedSession,
} from '../mocks/session.ts'
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
  { icon: navDashboard, label: '대시보드', href: '/app/dashboard', page: 'dashboard' },
  {
    badge: '12',
    icon: navLedger,
    label: '장부 작업',
    href: '/app/ledger',
    page: 'ledger',
  },
  { icon: navReport, label: '보고서', href: '/app/reports', page: 'reports' },
  { icon: navSources, label: '거래소·지갑', href: '/app/sources', page: 'sources' },
  { icon: navSettings, label: '설정', href: '/app/settings', page: 'settings' },
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
  const { user } = mockAuthenticatedSession
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
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

  function handleLogout() {
    logoutMockSession()
    window.history.replaceState({}, '', '/')
    window.dispatchEvent(new PopStateEvent('popstate'))
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

      <a className="app-sidebar__guide" href="/app/ledger">
        <strong>처음 사용하시나요?</strong>
        <span>장부 만들기 가이드를 확인하세요.</span>
      </a>

      <div className="app-sidebar__user-area" ref={userMenuRef}>
        {isUserMenuOpen && (
          <div className="app-sidebar__user-menu" role="menu">
            <div>
              <strong>{user.name}</strong>
              <span>Mock 로그인 계정</span>
            </div>
            <button type="button" role="menuitem" onClick={handleLogout}>
              로그아웃
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
            <strong>{user.name}</strong>
            <small>개인 장부</small>
          </span>
          <i aria-hidden="true">⌃</i>
        </button>
      </div>
    </aside>
  )
}
