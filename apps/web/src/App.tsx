import { AppHeader } from './components/AppHeader.tsx'
import { OnboardingOverview } from './components/OnboardingOverview.tsx'

export function App() {
  return (
    <div className="appShell">
      <AppHeader />

      <main>
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">GIWA MVP · WEB</p>
          <h1 id="hero-title">
            흩어진 거래 기록을
            <span>검토 가능한 장부로</span>
          </h1>
          <p className="heroDescription">
            거래소 파일과 지갑 주소를 연결하면 대장이 원본을 보존하고,
            거래 흐름을 정리해 확인이 필요한 항목을 보여줍니다.
          </p>
          <div className="heroActions">
            <a className="primaryAction" href="#onboarding">
              온보딩 흐름 보기
            </a>
            <a className="secondaryAction" href="#sources">
              연결 방식 확인
            </a>
          </div>
        </section>

        <OnboardingOverview />
      </main>

      <footer className="footer">
        <p>현재 화면은 웹 앱 구조와 온보딩 상태를 합의하기 위한 초기 틀입니다.</p>
      </footer>
    </div>
  )
}
