import { sourceJourney } from '../landing-content.ts'

export function SourceJourney() {
  return (
    <section className="source-journey" aria-labelledby="source-journey-title">
      <div className="source-journey__inner">
        <h2 id="source-journey-title">데이터 연결과 처리 결과</h2>
        <ol className="source-journey__list">
          {sourceJourney.map((item, index) => (
            <li className={`source-stage source-stage--${item.tone}`} key={item.label}>
              <span className="source-stage__dot" aria-hidden="true" />
              <span>{item.label}</span>
              {index < sourceJourney.length - 1 ? (
                <span className="source-stage__arrow" aria-hidden="true">
                  →
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
