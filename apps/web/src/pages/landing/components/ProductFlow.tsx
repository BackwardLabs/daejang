import { workflowSteps } from '../landing-content.ts'

export function ProductFlow() {
  return (
    <section className="flow-section ruled-section" id="how-it-works" aria-labelledby="flow-title">
      <div className="flow-section__inner">
        <div className="section-heading">
          <p className="section-eyebrow">HOW IT WORKS</p>
          <h2 id="flow-title">거래 기록을 세금 보고서로 만드는 네 단계</h2>
        </div>
        <ol className="workflow-list">
          {workflowSteps.map((step) => (
            <li key={step.number}>
              <span className="workflow-list__number">{step.number}</span>
              <h3>{step.title}</h3>
              <p>{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
