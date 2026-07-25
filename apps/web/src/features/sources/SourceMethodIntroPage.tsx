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
    isUpbitPdf ? 'PDF 등록 시작' : '지갑 연결 시작'

  return (
    <SourceFlowLayout
      badge={{ label: method.intro.badge, tone: method.tone, type: 'flow' }}
      description={method.intro.subtitle}
      eyebrow={method.intro.eyebrow}
      title={methodId === 'upbit-pdf' ? 'Upbit PDF 등록' : 'EVM Wallet 연결'}
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
            <a
              className="source-primary-action"
              href={
                isUpbitPdf
                  ? '/app/sources/new/upbit/upload'
                  : '/app/sources/new/wallet/connect'
              }
            >
              {actionLabel} <span aria-hidden="true">→</span>
            </a>
            <a href="/app/sources/new">
              <span aria-hidden="true">←</span> 연결 방식 다시 선택
            </a>
          </div>
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
                private key·seed phrase·쓰기·출금 권한을 요청하거나
                저장하지 않습니다. 오프체인 서명은 지갑 소유권 확인에만
                사용합니다.
              </p>
            )}
          </div>
        </aside>
      </section>

      <p className="source-footer-note">{method.intro.footer}</p>
    </SourceFlowLayout>
  )
}
