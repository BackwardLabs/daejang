export function AppHeader() {
  return (
    <header className="appHeader">
      <a className="brand" href="/" aria-label="대장 홈">
        <span className="brandMark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>daejang</span>
      </a>

      <nav className="mainNavigation" aria-label="주요 메뉴">
        <a href="#onboarding">온보딩</a>
        <a href="#sources">데이터 소스</a>
      </nav>
    </header>
  )
}
