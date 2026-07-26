import type { ReactNode } from 'react'
import { useState } from 'react'
import {
  AppSidebar,
  type AppYear,
} from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import { AppUtilityBar } from '../../components/AppUtilityBar.tsx'
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
  badge,
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
  const badgeLabel = badge
    ? badge.type === 'year'
      ? `${selectedYear} 과세연도`
      : badge.label
    : null

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
        <AppUtilityBar
          currentPage="거래소·지갑"
          syncLabel="동기화 전"
          syncTone="neutral"
          year={selectedYear}
        />
        <div className="source-content">
          <PageHeader
            actions={
              badge && badgeLabel ? (
                <span
                  className={`source-header-badge source-header-badge--${badge.tone}`}
                >
                  {badgeLabel}
                </span>
              ) : undefined
            }
            description={description}
            eyebrow={eyebrow}
            title={title}
            tone="source"
          />
          {children}
        </div>
      </main>
    </div>
  )
}
