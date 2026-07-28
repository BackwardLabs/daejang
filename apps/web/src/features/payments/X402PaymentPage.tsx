import { useEffect, useRef, useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  defaultX402PaymentClient,
  type SyntheticReport,
  type X402PaymentClient,
  type X402PaymentQuote,
  type X402PaymentResult,
  x402DemoTerms,
} from './x402PaymentApi.ts'
import './x402-payment.css'

type PaymentStatus =
  | 'quoteLoading'
  | 'quoteReady'
  | 'walletRequired'
  | 'signing'
  | 'settling'
  | 'delivered'
  | 'failed'
  | 'cancelled'

const statusCopy: Record<PaymentStatus, { label: string; title: string; body: string }> = {
  quoteLoading: {
    label: 'STATE · QUOTE',
    title: '402 결제 요구사항을 확인하고 있습니다',
    body: 'synthetic report route에 미결제 요청을 보내 GIWA Sepolia payment requirements를 읽습니다.',
  },
  quoteReady: {
    label: 'STATE · READY',
    title: 'mock payment payload 서명이 필요합니다',
    body: '아래 조건이 지갑 서명 내용과 일치할 때만 facilitator가 정산을 시도합니다.',
  },
  walletRequired: {
    label: 'STATE · WALLET',
    title: 'GIWA Sepolia 지갑 연결이 필요합니다',
    body: '브라우저 지갑을 연결하고 GIWA Sepolia 네트워크에서 EIP-3009 authorization을 서명해 주세요.',
  },
  signing: {
    label: 'STATE · SIGNING',
    title: '지갑에서 결제 payload를 서명하고 있습니다',
    body: '이 서명은 Mock USD의 transferWithAuthorization에만 사용되며 payer ETH는 필요하지 않습니다.',
  },
  settling: {
    label: 'STATE · SETTLING',
    title: 'facilitator가 GIWA Sepolia에서 정산하고 있습니다',
    body: '서명된 authorization을 검증한 뒤 온체인 transferWithAuthorization 트랜잭션을 제출합니다.',
  },
  delivered: {
    label: 'STATE · DELIVERED',
    title: '정산 증빙과 synthetic report를 받았습니다',
    body: 'PAYMENT-RESPONSE와 fixture 결과가 함께 도착했습니다. 이 화면은 상용 결제가 아닙니다.',
  },
  failed: {
    label: 'STATE · FAILED',
    title: 'x402 mock payment 흐름을 완료하지 못했습니다',
    body: '데모 API 설정, 결제 요구사항, 네트워크, 서명 또는 정산 응답을 확인해 주세요.',
  },
  cancelled: {
    label: 'STATE · CANCELLED',
    title: '서명이 취소되었습니다',
    body: '취소된 payload는 정산으로 처리하지 않습니다. 같은 payment requirements로 다시 시도할 수 있습니다.',
  },
}

const steps: Array<{ id: PaymentStatus; label: string }> = [
  { id: 'quoteReady', label: '402 견적' },
  { id: 'signing', label: 'payload 서명' },
  { id: 'settling', label: 'verify·settle' },
  { id: 'delivered', label: '200 전달' },
]

function formatAddress(value: string) {
  return `${value.slice(0, 6)}…${value.slice(-4)}`
}

function stepState(status: PaymentStatus, step: PaymentStatus) {
  const currentIndex = steps.findIndex((item) => item.id === step)
  const statusIndex =
    status === 'quoteLoading' || status === 'walletRequired' || status === 'failed' || status === 'cancelled'
      ? -1
      : steps.findIndex((item) => item.id === status)

  if (status === 'delivered' || statusIndex > currentIndex) return 'complete'
  if (statusIndex === currentIndex) return 'active'

  return 'pending'
}

function ReportSummary({ report }: { report: SyntheticReport }) {
  return (
    <section className="x402-result-card" aria-labelledby="x402-result-title">
      <span>SYNTHETIC FIXTURE</span>
      <h2 id="x402-result-title">{report.reportId}</h2>
      <dl>
        <div>
          <dt>거래</dt>
          <dd>{report.summary.transactions}건</dd>
        </div>
        <div>
          <dt>수입</dt>
          <dd>{report.summary.income}</dd>
        </div>
        <div>
          <dt>비용</dt>
          <dd>{report.summary.expense}</dd>
        </div>
        <div>
          <dt>순액</dt>
          <dd>{report.summary.net}</dd>
        </div>
      </dl>
      <p>
        fixture:true · productionReport:false · environment:{' '}
        {report.environment}
      </p>
    </section>
  )
}

function PaymentEvidence({ result }: { result: X402PaymentResult }) {
  return (
    <section className="x402-evidence-card" aria-labelledby="x402-evidence-title">
      <div>
        <span>PAYMENT-RESPONSE</span>
        <h2 id="x402-evidence-title">GIWA Sepolia 정산 증빙</h2>
      </div>
      <dl>
        <div>
          <dt>Network</dt>
          <dd>{result.paymentResponse.network}</dd>
        </div>
        <div>
          <dt>Payer</dt>
          <dd title={result.paymentResponse.payer}>
            {formatAddress(result.paymentResponse.payer)}
          </dd>
        </div>
        <div>
          <dt>Settlement tx</dt>
          <dd title={result.paymentResponse.transaction}>
            <a href={result.explorerUrl} rel="noreferrer" target="_blank">
              {formatAddress(result.paymentResponse.transaction)}
            </a>
          </dd>
        </div>
      </dl>
    </section>
  )
}

export function X402PaymentPage({
  client = defaultX402PaymentClient,
}: {
  client?: X402PaymentClient
}) {
  const [year, setYear] = useState<AppYear>('2027')
  const [status, setStatus] = useState<PaymentStatus>('quoteLoading')
  const [quote, setQuote] = useState<X402PaymentQuote>()
  const [result, setResult] = useState<X402PaymentResult>()
  const [message, setMessage] = useState('')
  const paymentController = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('quoteLoading')
    setMessage('')
    setResult(undefined)
    void client
      .loadQuote(controller.signal)
      .then((loadedQuote) => {
        setQuote(loadedQuote)
        setStatus('quoteReady')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setStatus('failed')
        setMessage(error instanceof Error ? error.message : '결제 요구사항을 읽지 못했습니다.')
      })

    return () => controller.abort()
  }, [client])

  async function handlePayment() {
    if (!quote || status === 'signing' || status === 'settling') return

    paymentController.current?.abort()
    const controller = new AbortController()
    paymentController.current = controller
    setMessage('')
    setResult(undefined)

    try {
      const paidResult = await client.executePayment(
        quote,
        controller.signal,
        (phase) => setStatus(phase),
      )
      setResult(paidResult)
      setStatus('delivered')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const errorMessage =
        error instanceof Error ? error.message : 'x402 mock payment를 완료하지 못했습니다.'
      setMessage(errorMessage)
      if (errorMessage.includes('취소')) {
        setStatus('cancelled')
      } else if (errorMessage.includes('지갑')) {
        setStatus('walletRequired')
      } else {
        setStatus('failed')
      }
    }
  }

  function handleCancel() {
    paymentController.current?.abort()
    setStatus('cancelled')
    setMessage('진행 중인 서명 또는 정산 요청을 중단했습니다.')
  }

  const copy = statusCopy[status]
  const isBusy = status === 'quoteLoading' || status === 'signing' || status === 'settling'
  const canPay = Boolean(quote) && !isBusy

  return (
    <div className="ledger-page x402-page product-shell">
      <AppSidebar activePage="reports" year={year} onYearChange={setYear} />
      <main className="x402-main">
        <PageHeader
          actions={<a className="x402-secondary-link" href="/reports">보고서로 돌아가기</a>}
          description="GIWA-69의 mock payment transport E2E를 제품 흐름 안에서 확인합니다."
          eyebrow="REPORTS · X402"
          title="GIWA Sepolia x402 데모"
          tone="workspace"
        />

        <section className="x402-notice" aria-label="mock payment 제한">
          <strong>Mock payment transport</strong>
          <span>
            실제 보고서 판매, 환불, 상용 정산이 아닙니다. GIWA Sepolia의 Mock USD로
            synthetic fixture 접근 경로만 검증합니다.
          </span>
        </section>

        <div className="x402-layout">
          <section className="x402-workspace" aria-labelledby="x402-workspace-title">
            <header>
              <div>
                <span>{copy.label}</span>
                <h2 id="x402-workspace-title">{copy.title}</h2>
                <p>{copy.body}</p>
              </div>
              <b data-status={status}>{status}</b>
            </header>

            <div className="x402-summary-grid">
              <div>
                <span>Amount</span>
                <strong>{x402DemoTerms.amountDisplay}</strong>
              </div>
              <div>
                <span>Network</span>
                <strong>GIWA Sepolia</strong>
              </div>
              <div>
                <span>Resource</span>
                <strong>Synthetic report</strong>
              </div>
              <div>
                <span>Token</span>
                <strong>Mock USD</strong>
              </div>
            </div>

            <nav className="x402-stepper" aria-label="x402 결제 단계">
              {steps.map((step) => (
                <span data-step-state={stepState(status, step.id)} key={step.id}>
                  {step.label}
                </span>
              ))}
            </nav>

            {message ? (
              <p className="x402-feedback" role={status === 'failed' ? 'alert' : 'status'}>
                {message}
              </p>
            ) : null}

            {result ? <ReportSummary report={result.report} /> : null}

            <div className="x402-actions">
              <button type="button" disabled={!canPay} onClick={() => void handlePayment()}>
                {status === 'signing'
                  ? '서명 대기 중'
                  : status === 'settling'
                    ? '정산 확인 중'
                    : status === 'delivered'
                      ? '다시 정산 데모 실행'
                      : '지갑에서 x402 payload 서명'}
              </button>
              {status === 'signing' || status === 'settling' ? (
                <button type="button" className="x402-outline-action" onClick={handleCancel}>
                  취소
                </button>
              ) : null}
            </div>
          </section>

          <aside className="x402-aside" aria-label="x402 결제 세부정보">
            <section>
              <span>PAYMENT REQUIREMENTS</span>
              <h2>GIWA-69 확정값</h2>
              <dl>
                <div>
                  <dt>Network</dt>
                  <dd>{x402DemoTerms.network}</dd>
                </div>
                <div>
                  <dt>Asset</dt>
                  <dd>{x402DemoTerms.assetDisplay}</dd>
                </div>
                <div>
                  <dt>Amount</dt>
                  <dd>{x402DemoTerms.amountAtomic} atomic</dd>
                </div>
                <div>
                  <dt>Token</dt>
                  <dd title={x402DemoTerms.asset}>{formatAddress(x402DemoTerms.asset)}</dd>
                </div>
                <div>
                  <dt>PayTo</dt>
                  <dd title={x402DemoTerms.payTo}>{formatAddress(x402DemoTerms.payTo)}</dd>
                </div>
              </dl>
            </section>

            {result ? <PaymentEvidence result={result} /> : (
              <section className="x402-aside-subtle">
                <span>FACILITATOR</span>
                <h2>역할</h2>
                <p>
                  facilitator는 서명을 검증하고 payer 대신 GIWA Sepolia에
                  transferWithAuthorization 트랜잭션을 제출합니다.
                </p>
              </section>
            )}
          </aside>
        </div>
      </main>
    </div>
  )
}
