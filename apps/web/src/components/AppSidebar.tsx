import navDashboard from '../assets/dashboard/nav-dashboard.svg'
import navLedger from '../assets/dashboard/nav-ledger.svg'
import navReport from '../assets/dashboard/nav-report.svg'
import navSettings from '../assets/dashboard/nav-settings.svg'
import navSources from '../assets/dashboard/nav-sources.svg'
import userAvatar from '../assets/dashboard/user-avatar.svg'
import { logout } from '../auth/api.ts'
import { setCurrentUser, useCurrentUser } from '../auth/session-store.ts'
import { Fragment, useState } from 'react'
import type { AppYear } from '../preferences/appPreferences.ts'
import { AccountProfileDialog } from './AccountProfileDialog.tsx'
import { AppLink } from './AppLink.tsx'
import { LedgerGuideDialog } from './LedgerGuideDialog.tsx'
import './app-sidebar.css'

export type AppPage = 'dashboard' | 'ledger' | 'reports' | 'settings' | 'sources'
export {
  defaultAppYear,
  type AppYear,
} from '../preferences/appPreferences.ts'

const abbreviateMiddle = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return '…'
  const headLength = Math.ceil((maxLength - 1) / 2)
  const tailLength = Math.floor((maxLength - 1) / 2)
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`
}

export const abbreviateEmail = (email: string, maxLength = 28) => {
  if (email.length <= maxLength) return email
  const atIndex = email.lastIndexOf('@')
  if (atIndex <= 0 || atIndex === email.length - 1) {
    return abbreviateMiddle(email, maxLength)
  }

  const local = email.slice(0, atIndex)
  const domain = email.slice(atIndex + 1)
  const preferredDomainLength = Math.min(domain.length, 18)
  const localLength = Math.max(3, maxLength - preferredDomainLength - 1)
  const compactLocal = abbreviateMiddle(local, localLength)
  const domainLength = Math.max(3, maxLength - compactLocal.length - 1)
  return `${compactLocal}@${abbreviateMiddle(domain, domainLength)}`
}

export type AppSidebarSecondaryItem = {
  badge?: string
  disabled?: boolean
  disabledReason?: string
  id: string
  label: string
}

const navigation: Array<{
  badge?: string
  href: `/${string}`
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
  const [isGuideOpen, setIsGuideOpen] = useState(false)
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const [logoutPending, setLogoutPending] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const accountLabel =
    user?.email ??
    (user?.displayName === 'GIWA 사용자' ? undefined : user?.displayName) ??
    '계정'
  const accountDisplayLabel = user?.email
    ? abbreviateEmail(user.email)
    : accountLabel

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
      <AppLink className="app-sidebar__brand" href="/" aria-label="Daejang 소개 페이지로 이동">
        <img src="/daejang-logo.svg" alt="" />
        <span>Daejang</span>
      </AppLink>

      <label className="app-sidebar__period">
        <span className="sr-only">조회 기간</span>
        <select
          value={year}
          onChange={(event) => onYearChange(event.target.value as AppYear)}
        >
          <option value="2027">2027년 · 전체 기간</option>
          <option value="2026">2026년 · 전체 기간</option>
          <option value="2025">2025년 · 전체 기간</option>
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
                  <AppLink
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
                  </AppLink>
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

      <button
        aria-haspopup="dialog"
        className="app-sidebar__guide"
        type="button"
        onClick={() => setIsGuideOpen(true)}
      >
        <strong>처음 사용하시나요?</strong>
        <span>장부 만들기 가이드를 확인하세요</span>
      </button>

      <div className="app-sidebar__user-area">
        <button
          type="button"
          className="app-sidebar__user"
          aria-label={`${accountLabel} 계정 메뉴 열기`}
          aria-expanded={isProfileOpen}
          aria-haspopup="dialog"
          title={accountLabel}
          onClick={() => setIsProfileOpen(true)}
        >
          <img src={userAvatar} alt="" />
          <span>
            <strong>{accountDisplayLabel}</strong>
            <small>개인 장부</small>
          </span>
          <i aria-hidden="true">›</i>
        </button>
      </div>

      {isGuideOpen ? (
        <LedgerGuideDialog onClose={() => setIsGuideOpen(false)} />
      ) : null}
      {isProfileOpen ? (
        <AccountProfileDialog
          logoutError={logoutError}
          logoutPending={logoutPending}
          user={user}
          onClose={() => {
            setLogoutError('')
            setIsProfileOpen(false)
          }}
          onLogout={handleLogout}
        />
      ) : null}
    </aside>
  )
}
