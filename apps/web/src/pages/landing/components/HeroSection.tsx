export function HeroSection({
  onStart,
}: {
  onStart: () => void
}) {
  return (
    <section className="hero-section" aria-labelledby="hero-title">
      <div className="hero-section__inner">
        <div className="hero-copy">
          <p className="eyebrow-badge">
            <span aria-hidden="true" />
            DIGITAL ASSET RECORDS
          </p>
          <h1 id="hero-title">
            흩어진 디지털 자산 기록,
            <span>한곳에서</span>
          </h1>
          <p className="hero-copy__description">
            거래소 거래내역과 개인지갑 기록을 한 형식으로 모아, 확인이 필요한
            항목과 계산 근거를 함께 보여줍니다.
          </p>
          <div className="button-row">
            <button className="button button--primary" type="button" onClick={onStart}>
              시작하기
            </button>
            <a className="button button--secondary" href="#how-it-works">
              작동 방식
            </a>
          </div>
        </div>

        <div className="hero-visual">
          <div className="hero-visual__wash" aria-hidden="true" />
          <div className="hero-visual__backplate" aria-hidden="true" />
          <span className="hero-visual__accent" aria-hidden="true" />
          <img
            className="hero-visual__primary"
            src="/landing/hero-dashboard.png"
            alt="대장의 자산 현황, 소스별 보유량과 보유 자산을 보여주는 대시보드"
            width="600"
            height="480"
            fetchPriority="high"
          />
          <img
            className="hero-visual__secondary"
            src="/landing/hero-review-result.png"
            alt="대장의 검토 반영 결과와 보고서 생성 근거를 보여주는 제품 화면"
            width="331"
            height="236"
          />
        </div>
      </div>
    </section>
  )
}
