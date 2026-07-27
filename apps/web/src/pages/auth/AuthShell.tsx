import type { MouseEvent, ReactNode } from 'react'
import type { PublicPath } from '../../auth/navigation.ts'
import { Brand } from '../landing/components/Brand.tsx'

type AuthShellProps = {
  children: ReactNode
  onHome: () => void
  onNavigate: (path: PublicPath) => void
  headerAction?: ReactNode
  sidebar?: ReactNode
}

export function AuthShell({
  children,
  onHome,
  onNavigate,
  headerAction,
  sidebar,
}: AuthShellProps) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: PublicPath) => {
    event.preventDefault()
    onNavigate(path)
  }

  return (
    <div className={sidebar ? 'auth-page auth-page--split' : 'auth-page'}>
      <header className="auth-header">
        <Brand
          href="/"
          onClick={(event) => {
            event.preventDefault()
            onHome()
          }}
        />
        {headerAction}
      </header>

      <div className="auth-layout">
        {sidebar}
        <main className="auth-main">{children}</main>
      </div>

      <footer className="auth-footer">
        <nav aria-label="정책 및 고객지원">
          <a href="/terms" onClick={(event) => navigate(event, '/terms')}>
            이용약관
          </a>
          <a href="/privacy" onClick={(event) => navigate(event, '/privacy')}>
            개인정보 처리방침
          </a>
          <a href="/support" onClick={(event) => navigate(event, '/support')}>
            고객지원
          </a>
        </nav>
        <span>© Backward Labs</span>
      </footer>
    </div>
  )
}
