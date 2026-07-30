import { type FormEvent, useState } from 'react'

import { AppSidebar } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  loadAppPreferences,
  saveAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import '../ledger/ledger.css'
import './product.css'

export type ProductPageKind = 'settings'

export function ProductPage({ kind: _kind }: { kind: ProductPageKind }) {
  const [selectedYear, setSelectedYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [draftYear, setDraftYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )
  const [saveStatus, setSaveStatus] = useState<'error' | 'saved'>()

  function handleSidebarYearChange(year: AppYear) {
    setSelectedYear(year)
    setDraftYear(year)
    setSaveStatus(saveAppYear(year) ? undefined : 'error')
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const saved = saveAppPreferences({
      currency: 'KRW',
      year: draftYear,
    })

    if (!saved) {
      setSaveStatus('error')
      return
    }

    setSelectedYear(draftYear)
    setSaveStatus('saved')
  }

  return (
    <div className="ledger-page product-page product-shell">
      <AppSidebar
        activePage="settings"
        year={selectedYear}
        onYearChange={handleSidebarYearChange}
      />

      <main className="product-main">
        <div className="product-content">
          <PageHeader
            description="장부 생성 기간과 표시 환경을 관리합니다."
            eyebrow="SETTINGS"
            title="설정"
            tone="product"
          />

          <form
            className="product-settings-card"
            aria-labelledby="product-settings-title"
            onSubmit={handleSave}
          >
            <h2 id="product-settings-title">장부 기본 설정</h2>
            <label>
              <span>기본 조회 연도</span>
              <select
                value={draftYear}
                onChange={(event) => {
                  setDraftYear(event.target.value as AppYear)
                  setSaveStatus(undefined)
                }}
              >
                <option value="2027">2027년</option>
                <option value="2026">2026년</option>
                <option value="2025">2025년</option>
              </select>
            </label>
            <label>
              <span>금액 표시 통화</span>
              <select defaultValue="KRW">
                <option value="KRW">KRW · 대한민국 원</option>
                <option value="USD" disabled>
                  USD · 미국 달러 (환율 변환 준비 중)
                </option>
              </select>
            </label>
            <p className="product-settings-note">
              이 설정은 현재 사용 중인 브라우저에 저장되며 다른 기기에는
              자동으로 적용되지 않습니다.
            </p>
            <div className="product-settings-actions">
              <button type="submit">설정 저장</button>
              {saveStatus === 'saved' ? (
                <p role="status">이 브라우저에 설정을 저장했습니다.</p>
              ) : null}
              {saveStatus === 'error' ? (
                <p className="is-error" role="alert">
                  설정을 저장하지 못했습니다. 브라우저 설정을 확인한 뒤 다시
                  시도해 주세요.
                </p>
              ) : null}
            </div>
          </form>
        </div>
      </main>
    </div>
  )
}
