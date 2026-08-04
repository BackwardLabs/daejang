import { useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import {
  getCurrentLegalDocuments,
  WebApiError,
  type LegalDocument,
} from '../../auth/api.ts'
import type { PublicPath } from '../../auth/navigation.ts'
import { LegalDocumentContent } from '../../components/auth/LegalDocumentContent.tsx'
import { Brand } from '../landing/components/Brand.tsx'
import {
  supportEmail,
  supportFaqs,
  supportKakaoUrl,
} from './support-content.ts'
import '../auth/auth-pages.css'

type PublicPageProps = {
  onHome: () => void
  onNavigate: (path: PublicPath) => void
}

function PublicHeader({ onHome, onNavigate }: PublicPageProps) {
  return (
    <header className="public-header">
      <Brand
        href="/"
        onClick={(event) => {
          event.preventDefault()
          onHome()
        }}
      />
      <nav aria-label="정책 및 고객지원">
        <button type="button" onClick={() => onNavigate('/terms')}>이용약관</button>
        <button type="button" onClick={() => onNavigate('/privacy')}>개인정보 처리방침</button>
        <button type="button" onClick={() => onNavigate('/support')}>고객지원</button>
      </nav>
      <button className="auth-outline-button" type="button" onClick={onHome}>
        서비스로 돌아가기
      </button>
    </header>
  )
}

function PublicFooter({ onNavigate }: Pick<PublicPageProps, 'onNavigate'>) {
  const navigate = (event: MouseEvent<HTMLAnchorElement>, path: PublicPath) => {
    event.preventDefault()
    onNavigate(path)
  }

  return (
    <footer className="public-footer">
      <span>© Backward Labs</span>
      <nav aria-label="하단 정책 메뉴">
        <a href="/terms" onClick={(event) => navigate(event, '/terms')}>이용약관</a>
        <a href="/privacy" onClick={(event) => navigate(event, '/privacy')}>개인정보 처리방침</a>
        <a href="/support" onClick={(event) => navigate(event, '/support')}>고객지원</a>
      </nav>
    </footer>
  )
}

function useMainFocus() {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return ref
}

function PolicyPage({
  title,
  description,
  documentType,
  ...props
}: PublicPageProps & {
  title: string
  description: string
  documentType: 'terms' | 'privacy'
}) {
  const mainRef = useMainFocus()
  const [document, setDocument] = useState<LegalDocument | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadDocument = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getCurrentLegalDocuments()
      const current = response.documents.find(
        (candidate) => candidate.documentType === documentType,
      )
      if (!current) {
        throw new Error('CURRENT_LEGAL_DOCUMENT_NOT_FOUND')
      }
      setDocument(current)
    } catch (caught) {
      setDocument(null)
      setError(
        caught instanceof WebApiError
          ? caught.message
          : '현재 적용 중인 문서를 불러오지 못했습니다',
      )
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadDocument()
  }, [documentType])

  return (
    <div className="public-page">
      <PublicHeader {...props} />
      <main ref={mainRef} className="public-main" tabIndex={-1}>
        <header className="public-intro">
          <p>
            {document
              ? `버전 ${document.version} · ${new Date(document.effectiveAt).toLocaleDateString('ko-KR')} 시행`
              : 'CURRENT POLICY'}
          </p>
          <h1>{title}</h1>
          <span>{description}</span>
        </header>
        {loading ? <p className="auth-state" role="status">문서를 불러오는 중</p> : null}
        {error ? (
          <div className="auth-state auth-state--error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={loadDocument}>다시 시도</button>
          </div>
        ) : null}
        {document ? (
          <div className="policy-layout">
            <aside aria-label={`${title} 문서 정보`}>
              <strong>문서 정보</strong>
              <dl>
                <div><dt>버전</dt><dd>{document.version}</dd></div>
                <div>
                  <dt>시행일</dt>
                  <dd>{new Date(document.effectiveAt).toLocaleDateString('ko-KR')}</dd>
                </div>
                <div><dt>언어</dt><dd>{document.locale}</dd></div>
              </dl>
            </aside>
            <article className="policy-document">
              <LegalDocumentContent content={document.content} />
            </article>
          </div>
        ) : null}
      </main>
      <PublicFooter onNavigate={props.onNavigate} />
    </div>
  )
}

export function TermsPage(props: PublicPageProps) {
  return (
    <PolicyPage
      {...props}
      title="서비스 이용약관"
      description="Daejang 서비스 이용 조건과 계정·본인확인·자료 처리 기준"
      documentType="terms"
    />
  )
}

export function PrivacyPage(props: PublicPageProps) {
  return (
    <PolicyPage
      {...props}
      title="개인정보 처리방침"
      description="처리하는 정보와 목적, 보유기간, 이용자 권리 안내"
      documentType="privacy"
    />
  )
}

export function SupportPage(props: PublicPageProps) {
  const mainRef = useMainFocus()
  const [openFaq, setOpenFaq] = useState(0)

  return (
    <div className="public-page">
      <PublicHeader {...props} />
      <main ref={mainRef} className="public-main" tabIndex={-1}>
        <header className="public-intro">
          <p>SUPPORT</p>
          <h1>고객지원</h1>
          <span>자주 묻는 질문을 확인하고 해결되지 않으면 문의해 주세요</span>
        </header>
        <div className="support-layout">
          <section className="support-faq" aria-labelledby="support-faq-title">
            <h2 id="support-faq-title">자주 묻는 질문</h2>
            {supportFaqs.map((faq, index) => {
              const open = index === openFaq
              return (
                <article key={faq.question}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenFaq(open ? -1 : index)}
                  >
                    <span>{faq.question}</span>
                    <span aria-hidden="true">{open ? '−' : '+'}</span>
                  </button>
                  {open ? <p>{faq.answer}</p> : null}
                </article>
              )
            })}
          </section>
          <aside className="support-contact" aria-label="문의 채널">
            <h2>직접 문의하기</h2>
            <article>
              <span aria-hidden="true">K</span>
              <h3>카카오톡 채널</h3>
              <p>계정과 서비스 이용 문의</p>
              <a href={supportKakaoUrl} target="_blank" rel="noreferrer">
                채널로 문의하기
              </a>
            </article>
            <article>
              <span aria-hidden="true">@</span>
              <h3>이메일</h3>
              <p>답변에 자료 확인이 필요한 문의</p>
              <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
            </article>
          </aside>
        </div>
      </main>
      <PublicFooter onNavigate={props.onNavigate} />
    </div>
  )
}

export function NotFoundPage(props: PublicPageProps) {
  const mainRef = useMainFocus()
  return (
    <div className="public-page">
      <PublicHeader {...props} />
      <main ref={mainRef} className="public-main public-not-found" tabIndex={-1}>
        <span>404</span>
        <h1>요청한 화면을 찾을 수 없습니다</h1>
        <p>주소를 다시 확인하거나 랜딩으로 돌아가 주세요</p>
        <button type="button" onClick={props.onHome}>랜딩으로 돌아가기</button>
      </main>
      <PublicFooter onNavigate={props.onNavigate} />
    </div>
  )
}
