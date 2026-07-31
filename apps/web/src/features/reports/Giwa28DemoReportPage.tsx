import { useState } from 'react'

import { AppSidebar } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  loadAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import { SyntheticReportAttestationPanel } from './SyntheticReportAttestationPanel.tsx'
import './report.css'

export function ReportPage() {
  const [year, setYear] = useState<AppYear>(
    () => loadAppPreferences().year,
  )

  function handleYearChange(nextYear: AppYear) {
    setYear(nextYear)
    saveAppYear(nextYear)
  }

  return (
    <div className="ledger-page report-page product-shell">
      <AppSidebar
        activePage="reports"
        year={year}
        onYearChange={handleYearChange}
      />
      <main className="report-main">
        <PageHeader
          description="GIWA-28 합성 장부의 온체인 제출과 검토 흐름을 확인합니다."
          eyebrow="REPORTS · DEMO"
          title="보고서 데모"
          tone="workspace"
        />

        <SyntheticReportAttestationPanel />
      </main>
    </div>
  )
}
