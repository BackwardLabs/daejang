import { useState } from 'react'
import { faqs } from '../landing-content.ts'

function splitFaqAnswer(answer: string) {
  return answer.match(/[^.]+(?:\.|$)/g)?.map((sentence) => sentence.trim()) ?? [answer]
}

export function FaqSection() {
  const [openId, setOpenId] = useState<string | null>(null)

  return (
    <section className="faq-section ruled-section" id="faq" aria-labelledby="faq-title">
      <div className="faq-section__inner">
        <div className="section-heading">
          <p className="section-eyebrow">FAQ</p>
          <h2 id="faq-title">자주 묻는 질문</h2>
        </div>
        <div className="faq-list">
          {faqs.map((faq) => {
            const isOpen = openId === faq.id
            const answerId = `faq-answer-${faq.id}`

            return (
              <article className="faq-item" id={`faq-${faq.id}`} key={faq.id}>
                <h3>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={answerId}
                    onClick={() => setOpenId(isOpen ? null : faq.id)}
                  >
                    <span>{faq.question}</span>
                    <span className="faq-item__icon" aria-hidden="true">
                      {isOpen ? '−' : '+'}
                    </span>
                  </button>
                </h3>
                {isOpen ? (
                  <div className="faq-item__answer" id={answerId}>
                    <p>
                      {splitFaqAnswer(faq.answer).map((sentence, index) => (
                        <span key={faq.id + index}>{sentence}</span>
                      ))}
                    </p>
                  </div>
                ) : null}
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
