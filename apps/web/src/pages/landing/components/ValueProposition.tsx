import { principles } from '../landing-content.ts'

export function ValueProposition() {
  return (
    <section className="value-section" id="product" aria-labelledby="value-title">
      <div className="value-section__inner">
        <p className="section-eyebrow">WHY DAEJANG</p>
        <h2 id="value-title">거래내역 원본부터 세금 보고서까지, 처리 과정을 한눈에</h2>
        <p className="value-section__description">
          거래소 문서와 개인지갑 기록을 한 형식으로 정리하고, 확인이 필요한 거래를 검토한
          뒤 세금 보고서를 생성합니다.
        </p>
        <ol className="principle-list">
          {principles.map((principle) => (
            <li key={principle.number}>
              <span>{principle.number}</span>
              <h3>{principle.title}</h3>
              <p>{principle.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
