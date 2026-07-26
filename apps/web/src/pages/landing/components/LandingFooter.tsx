import { Brand } from './Brand.tsx'

export function LandingFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__pattern" aria-hidden="true" />
      <div className="site-footer__top">
        <div>
          <Brand />
          <p>디지털 자산 기록을 한곳에서</p>
        </div>
        <nav className="site-footer__nav" aria-label="하단 메뉴">
          <a href="#product">제품</a>
          <a href="#how-it-works">작동 방식</a>
          <a href="#faq">FAQ</a>
        </nav>
      </div>
      <div className="site-footer__bottom">
        <p>© Backward Labs</p>
        <div className="site-footer__policies" aria-label="정책">
          <span>이용약관</span>
          <span>개인정보 처리방침</span>
        </div>
      </div>
    </footer>
  )
}
