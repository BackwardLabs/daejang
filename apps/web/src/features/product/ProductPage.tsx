import { useState } from 'react'

import { AppSidebar, type AppYear } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import '../ledger/ledger.css'
import './product.css'

export type ProductPageKind = 'settings'

export function ProductPage({ kind: _kind }: { kind: ProductPageKind }) {
  const [selectedYear, setSelectedYear] = useState<AppYear>('2027')

  return (
    <div className="ledger-page product-page product-shell">
      <AppSidebar
        activePage="settings"
        year={selectedYear}
        onYearChange={setSelectedYear}
      />

      <main className="product-main">
        <div className="product-content">
          <PageHeader
            description="장부 생성 기간과 표시 환경을 관리합니다."
            eyebrow="SETTINGS"
            title="설정"
            tone="product"
          />

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
        </div>
      </main>
    </div>
  )
}
