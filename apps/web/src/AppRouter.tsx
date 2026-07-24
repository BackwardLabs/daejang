import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import { DashboardPage } from './features/dashboard/DashboardPage.tsx'
import { LedgerPage } from './features/ledger/LedgerPage.tsx'
import { ReportPage } from './features/reports/ReportPage.tsx'
import { SourceManagementPage } from './features/sources/SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './features/sources/SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './features/sources/SourceTypeSelectionPage.tsx'
import { UpbitPdfRegistrationPage } from './features/sources/UpbitPdfRegistrationPage.tsx'
import { CollectionPeriodPage } from './features/sources/CollectionPeriodPage.tsx'
import {
  ProductPage,
  type ProductPageKind,
} from './features/product/ProductPage.tsx'
import { isMockSessionAuthenticated } from './mocks/session.ts'

function normalizePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '')

  return normalized || '/'
}

function getCollectionPeriodSourceId(path: string) {
  const match = path.match(/^\/app\/sources\/([^/]+)\/period$/)

  if (!match) {
    return null
  }

  const encodedSourceId = match[1]
  if (!encodedSourceId) {
    return null
  }

  try {
    return decodeURIComponent(encodedSourceId)
  } catch {
    return null
  }
}

export function AppRouter() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname))

  useEffect(() => {
    function handlePathChange() {
      setPath(normalizePath(window.location.pathname))
    }

    window.addEventListener('popstate', handlePathChange)
    return () => window.removeEventListener('popstate', handlePathChange)
  }, [])

  if (path.startsWith('/app/') && !isMockSessionAuthenticated()) {
    return <App />
  }

  if (path === '/app/dashboard' || path === '/features/dashboard') {
    return <DashboardPage />
  }

  if (path === '/app/ledger' || path === '/features/ledger') {
    return <LedgerPage />
  }

  if (path === '/app/reports' || path === '/features/reports') {
    return <ReportPage />
  }

  if (path === '/app/sources') {
    return <SourceManagementPage />
  }

  const collectionPeriodSourceId = getCollectionPeriodSourceId(path)

  if (collectionPeriodSourceId) {
    return (
      <CollectionPeriodPage
        key={collectionPeriodSourceId}
        sourceId={collectionPeriodSourceId}
      />
    )
  }

  if (path === '/app/sources/new') {
    return <SourceTypeSelectionPage />
  }

  if (path === '/app/sources/new/upbit') {
    return <SourceMethodIntroPage methodId="upbit-pdf" />
  }

  if (path === '/app/sources/new/upbit/upload') {
    return <UpbitPdfRegistrationPage />
  }

  if (path === '/app/sources/new/wallet') {
    return <SourceMethodIntroPage methodId="evm-address" />
  }

  const productRoutes: Partial<Record<string, ProductPageKind>> = {
    '/app/settings': 'settings',
  }
  const productPage = productRoutes[path]

  if (productPage) {
    return <ProductPage kind={productPage} />
  }

  return <App />
}
