import { Brand } from './Brand.tsx'

export function LandingHeader({
  onStart,
  signupAvailable,
}: {
  onStart: () => void
  signupAvailable: boolean
}) {
  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Brand />

        <div className="site-header__actions">
          <nav className="site-nav" aria-label="주요 메뉴">
            <a href="#product">제품</a>
            <a href="#how-it-works">작동 방식</a>
            <a href="#faq">FAQ</a>
            <a href="https://daejang.backwardlabs.io/docs">Docs</a>
          </nav>
          <button
            className="button button--primary button--header"
            type="button"
            onClick={onStart}
            disabled={!signupAvailable}
          >
            {signupAvailable ? '시작하기' : '가입 준비 중'}
          </button>
        </div>
      </div>
    </header>
  )
}
