import type { ReactNode } from 'react'
import { useState } from 'react'
import {
  AppSidebar,
  type AppYear,
} from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import './source-flow.css'

type SourceHeaderBadge = {
  label: string
  tone: 'evm' | 'upbit'
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
          actions={badge ? (
            <span
              className={`source-header-badge source-header-badge--${badge.tone}`}
            >
              {badge.label}
            </span>
          ) : undefined}
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
