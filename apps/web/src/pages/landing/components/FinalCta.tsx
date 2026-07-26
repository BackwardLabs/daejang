export function FinalCta() {
  return (
    <section className="final-cta ruled-section" id="get-started" aria-labelledby="cta-title">
      <div className="final-cta__card">
        <div>
          <p className="section-eyebrow">GET STARTED</p>
          <h2 id="cta-title">첫 기록부터 장부에</h2>
          <p>거래소 거래내역 문서나 개인지갑 주소로 바로 시작할 수 있습니다.</p>
        </div>
        <div className="button-row">
          <a className="button button--secondary" href="#how-it-works">
            제품 흐름 보기
          </a>
          <button
            className="button button--primary"
            type="button"
            aria-label="시작하기, 가입 기능 연결 예정"
            title="가입 기능 연결 예정"
            disabled
          >
            시작하기
          </button>
        </div>
      </div>
    </section>
  )
}
