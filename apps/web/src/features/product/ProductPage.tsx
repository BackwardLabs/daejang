import { useState } from 'react'
import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { productPageCopy, productSourceMocks } from '../../mocks/product.ts'
import '../ledger/ledger.css'
import './product.css'

export type ProductPageKind = 'settings' | 'sources'

export function ProductPage({ kind }: { kind: ProductPageKind }) {
  const copy = productPageCopy[kind]
  const [baseConnected, setBaseConnected] = useState(false)
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')

  return (
    <div className="ledger-page product-page product-shell">
      <AppSidebar
        activePage={kind}
        year={selectedYear}
        onYearChange={setSelectedYear}
      />

      <main className="product-main">
        <PageHeader
          description={copy.description}
          eyebrow={copy.eyebrow}
          title={copy.title}
          tone="product"
        />

        {kind === 'sources' && (
          <section className="product-source-list" aria-labelledby="source-list-title">
            <div>
              <p>CONNECTED SOURCES</p>
              <h2 id="source-list-title">연결 상태</h2>
            </div>
            {productSourceMocks.map((source, index) => (
              <article key={source.name}>
                <span>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{source.name}</h3>
                  <p>{source.detail}</p>
                </div>
                {source.interactive ? (
                  <button type="button" onClick={() => setBaseConnected((value) => !value)}>
                    {baseConnected ? '연결 해제' : '소스 연결'}
                  </button>
                ) : (
                  <strong>{source.status}</strong>
                )}
              </article>
            ))}
            <a href="/app/ledger">장부 작업으로 이동 →</a>
          </section>
        )}

        {kind === 'settings' && (
          <section className="product-settings-card">
            <h2>장부 기본 설정</h2>
            <label>
              <span>기본 조회 연도</span>
              <select defaultValue="2027">
                <option value="2027">2027년</option>
                <option value="2026">2026년</option>
              </select>
            </label>
            <label>
              <span>금액 표시 통화</span>
              <select defaultValue="KRW">
                <option value="KRW">KRW · 대한민국 원</option>
                <option value="USD">USD · 미국 달러</option>
              </select>
            </label>
          </section>
        )}
      </main>
    </div>
  )
}
