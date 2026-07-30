import type { ReactNode } from 'react'
import { useState } from 'react'
import { AppSidebar } from '../../components/AppSidebar.tsx'
import { PageHeader } from '../../components/PageHeader.tsx'
import {
  loadAppPreferences,
  saveAppYear,
  type AppYear,
} from '../../preferences/appPreferences.ts'
import './source-flow.css'

type SourceHeaderBadge = {
  label: string
  tone: 'evm' | 'upbit'
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
    useState<AppYear>(() => loadAppPreferences().year)

  function handleYearChange(year: AppYear) {
    setSelectedYear(year)
    saveAppYear(year)
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
