import {
  sourceMethodBullets,
  sourceMethodDefinitions,
  type SourceMethodDefinition,
} from './sourceDefinitions.ts'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'

function SourceMethodCard({
  method,
}: {
  method: SourceMethodDefinition
}) {
  return (
    <article className={`source-method-card source-method-card--${method.tone}`}>
      <header>
        <img src={method.logo} alt="" />
        <span>{method.badge}</span>
      </header>
      <h2>{method.title}</h2>
      <p>{method.description}</p>
      <ul>
        {method.bullets.map((bullet) => (
          <li key={bullet}>
            <img src={sourceMethodBullets[method.tone]} alt="" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
      <div className="source-method-card__notice" role="note">
        <strong>{method.noticeTitle}</strong>
        <span>{method.noticeBody}</span>
      </div>
      <a className="source-primary-action" href={method.href}>
        {method.id === 'upbit-pdf' ? 'Upbit PDF 선택' : 'EVM 공개 주소 선택'}
        <span aria-hidden="true">→</span>
      </a>
    </article>
  )
}

export function SourceTypeSelectionPage() {
  return (
    <SourceFlowLayout
      description="연결할 데이터의 출처와 방식을 선택하세요."
      title="데이터 소스 추가"
    >
      <div className="source-mvp-guide" role="note">
        <strong>MVP</strong>
        <span>
          Upbit는 PDF 업로드, EVM은 공개 주소 읽기 방식으로 연결합니다.
        </span>
      </div>

      <section className="source-method-grid" aria-label="데이터 소스 연결 방식">
        <SourceMethodCard method={sourceMethodDefinitions['upbit-pdf']} />
        <SourceMethodCard method={sourceMethodDefinitions['evm-address']} />
      </section>

      <p className="source-footer-note">
        두 방식 모두 소스 등록과 조회 기간 확인 후 수집 작업을 시작합니다.
      </p>
    </SourceFlowLayout>
  )
}
