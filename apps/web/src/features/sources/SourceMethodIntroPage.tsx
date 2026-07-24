import {
  sourceMethodBullets,
  sourceMethodDefinitions,
  type SourceMethodId,
} from './sourceDefinitions.ts'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'

export function SourceMethodIntroPage({
  methodId,
}: {
  methodId: SourceMethodId
}) {
  const method = sourceMethodDefinitions[methodId]
  const isUpbitPdf = methodId === 'upbit-pdf'
  const actionLabel =
    isUpbitPdf ? 'PDF 등록 시작' : '공개 주소 등록 시작'

  return (
    <SourceFlowLayout
      badge={{ label: method.intro.badge, tone: method.tone }}
      description={method.intro.subtitle}
      eyebrow={method.intro.eyebrow}
      title={methodId === 'upbit-pdf' ? 'Upbit PDF 등록' : 'EVM 공개 주소 등록'}
    >
      <section
        className={`source-intro-card source-intro-card--${method.tone}`}
      >
        <div className="source-intro-card__content">
          <header>
            <img src={method.logo} alt="" />
            <span>{method.badge}</span>
          </header>
          <h2>{method.intro.title}</h2>
          <p>{method.intro.description}</p>

          <div className="source-intro-standards">
            <h3>{method.intro.standardsLabel}</h3>
            <ul>
              {method.bullets.map((bullet) => (
                <li key={bullet}>
                  <img src={sourceMethodBullets[method.tone]} alt="" />
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="source-intro-notice" role="note">
            <strong>{method.intro.noticeTitle}</strong>
            <span>{method.intro.noticeBody}</span>
          </div>

          <div className="source-intro-actions">
            {isUpbitPdf ? (
              <a
                className="source-primary-action"
                href="/sources/new/upbit/upload"
              >
                {actionLabel} <span aria-hidden="true">→</span>
              </a>
            ) : (
              <button
                type="button"
                className="source-primary-action"
                disabled
                aria-describedby={`${method.id}-follow-up`}
              >
                {actionLabel} <span aria-hidden="true">→</span>
              </button>
            )}
            <a href="/sources/new">
              <span aria-hidden="true">←</span> 연결 방식 다시 선택
            </a>
          </div>
          {!isUpbitPdf ? (
            <p id={`${method.id}-follow-up`} className="source-follow-up-note">
              입력·업로드 단계는 다음 stacked PR에서 연결됩니다.
            </p>
          ) : null}
        </div>

        <aside className="source-intro-summary" aria-label={`${method.title} 등록 흐름`}>
          <h2>등록 흐름</h2>
          <ol>
            {method.intro.steps.map((step, index) => (
              <li key={step.label}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <strong>{step.label}</strong>
                  <p>{step.description}</p>
                </div>
              </li>
            ))}
          </ol>
          <div>
            <strong>보안 원칙</strong>
            {isUpbitPdf ? (
              <p>
                PDF 비밀번호는 파일 처리에만 사용하고 저장하지 않습니다.
                계정 자격증명·private key·seed phrase는 요청하지 않습니다.
              </p>
            ) : (
              <p>
                파일 암호·계정 자격증명·private key·seed phrase를 요청하거나
                저장하지 않습니다.
              </p>
            )}
          </div>
        </aside>
      </section>

      <p className="source-footer-note">{method.intro.footer}</p>
    </SourceFlowLayout>
  )
}
