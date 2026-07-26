import { principles } from '../landing-content.ts'

export function ValueProposition() {
  return (
    <section className="value-section" id="product" aria-labelledby="value-title">
      <div className="value-section__inner">
        <p className="section-eyebrow">WHY DAEJANG</p>
        <h2 id="value-title">원본부터 보고서까지, 확인 가능한 흐름</h2>
        <p className="value-section__description">
          가져온 원본은 그대로 보관하고, 정리 과정과 사용자 판단은 기록으로 남깁니다.
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
