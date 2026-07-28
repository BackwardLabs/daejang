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
import '../auth/auth-pages.css'

type PublicPageProps = {
  onHome: () => void
  onNavigate: (path: PublicPath) => void
}

const supportFaqs = [
  {
    question: '기존 계정이 있다고 표시되는 이유는 무엇인가요?',
    answer:
      '같은 본인확인 정보나 이미 등록된 로그인 수단이 확인되면 새 계정을 만들지 않습니다. 보안을 위해 화면에는 기존 계정의 상세 정보를 표시하지 않습니다.',
  },
  {
    question: '본인확인이 계속 실패해요',
    answer:
      '이름과 휴대전화 명의를 확인한 뒤 다시 시도해 주세요. 문제가 계속되면 오류가 발생한 시각과 화면을 고객지원에 알려 주세요. 주민등록번호나 신분증 사본은 이메일로 보내면 안 됩니다.',
  },
  {
    question: '다른 소셜 로그인을 같은 계정에 추가할 수 있나요?',
    answer:
      '같은 Daejang 계정에 지원하는 로그인 수단을 추가할 수 있도록 설계합니다. 연결할 때는 기존 계정과 새 소셜 계정을 각각 다시 인증하며 이메일이나 이름이 같아도 자동으로 합치지 않습니다.',
  },
  {
    question: '이미 등록된 지갑이라고 표시돼요',
    answer:
      '동일한 지갑 주소를 여러 계정에 중복 등록하지 않도록 제한할 수 있습니다. 문제가 계속되면 공개 지갑 주소와 오류 시각을 알려 주세요. 개인키나 시드 문구는 보내면 안 됩니다.',
  },
  {
    question: '업로드한 문서는 어떻게 처리되나요?',
    answer:
      '지원하는 거래자료를 정리하기 위해 문서 원본과 파싱 결과를 처리합니다. 처리 항목, 보유기간과 삭제 방법은 개인정보 처리방침에서 확인할 수 있습니다.',
  },
]

function safeHttpsUrl(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function mailtoUrl(value: string | undefined) {
  if (!value) return undefined
  const email = value.replace(/^mailto:/, '')
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? `mailto:${email}`
    : undefined
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
  const kakaoUrl = safeHttpsUrl(import.meta.env.VITE_SUPPORT_KAKAO_URL?.trim())
  const emailUrl = mailtoUrl(import.meta.env.VITE_SUPPORT_EMAIL?.trim())

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
              {kakaoUrl ? (
                <a href={kakaoUrl} target="_blank" rel="noreferrer">채널로 문의하기</a>
              ) : (
                <span className="support-contact__pending">채널 준비 중</span>
              )}
            </article>
            <article>
              <span aria-hidden="true">@</span>
              <h3>이메일</h3>
              <p>답변에 자료 확인이 필요한 문의</p>
              {emailUrl ? (
                <a href={emailUrl}>이메일 보내기</a>
              ) : (
                <span className="support-contact__pending">이메일 준비 중</span>
              )}
            </article>
            <p className="support-security-note">
              개인키, 시드 문구, 주민등록번호와 인증번호는 보내지 마세요
            </p>
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
