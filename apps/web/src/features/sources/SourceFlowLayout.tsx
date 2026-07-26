import type { ReactNode } from 'react'
import { useState } from 'react'
import {
  AppSidebar,
  type AppYear,
} from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import './source-flow.css'

type SourceHeaderBadge =
  | {
      tone: 'neutral'
      type: 'year'
    }
  | {
      label: string
      tone: 'evm' | 'upbit'
      type: 'flow'
    }

const sourceFlowYearStorageKey = 'source-flow-year.v1'

function readSourceFlowYear(): AppYear {
  const storedYear = window.sessionStorage.getItem(sourceFlowYearStorageKey)

  return storedYear === '2026' ? '2026' : '2027'
}

export function SourceFlowLayout({
  badge = { tone: 'neutral', type: 'year' },
  children,
  description,
  eyebrow = 'DATA SOURCES',
  title,
}: {
  badge?: SourceHeaderBadge
  children: ReactNode
  description: string
  eyebrow?: string
  title: string
}) {
  const [selectedYear, setSelectedYear] =
    useState<AppYear>(readSourceFlowYear)
  const badgeLabel =
    badge.type === 'year' ? `${selectedYear} 과세연도` : badge.label

  function handleYearChange(year: AppYear) {
    window.sessionStorage.setItem(sourceFlowYearStorageKey, year)
    setSelectedYear(year)
  }

  return (
    <div className="product-shell source-page">
      <AppSidebar
        activePage="sources"
        year={selectedYear}
        onYearChange={handleYearChange}
      />

      <main className="source-main">
        <PageHeader
          actions={
            <span
              className={`source-header-badge source-header-badge--${badge.tone}`}
            >
              {badgeLabel}
            </span>
          }
          description={description}
          eyebrow={eyebrow}
          title={title}
          tone="source"
        />
        {children}
      </main>
    </div>
  )
}
