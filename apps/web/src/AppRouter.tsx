import { lazy, Suspense, useEffect, useState } from 'react'
import { App } from './App.tsx'
import { DashboardPage } from './features/dashboard/DashboardPage.tsx'
import { LedgerPage } from './features/ledger/LedgerPage.tsx'
import { ReportPage } from './features/reports/ReportPage.tsx'
import { SourceManagementPage } from './features/sources/SourceManagementPage.tsx'
import { SourceMethodIntroPage } from './features/sources/SourceMethodIntroPage.tsx'
import { SourceTypeSelectionPage } from './features/sources/SourceTypeSelectionPage.tsx'
import { UpbitPdfRegistrationPage } from './features/sources/UpbitPdfRegistrationPage.tsx'
import {
  ProductPage,
  type ProductPageKind,
} from './features/product/ProductPage.tsx'
import { isMockSessionAuthenticated } from './mocks/session.ts'

const ReownEvmWalletConnectionRoute = lazy(async () => {
  const module = await import(
    './features/sources/ReownEvmWalletConnectionRoute.tsx'
  )

  return { default: module.ReownEvmWalletConnectionRoute }
})

function normalizePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '')

  return normalized || '/'
}

const protectedRoutes = new Set([
  '/dashboard',
  '/ledger',
  '/reports',
  '/settings',
  '/sources',
])

export function AppRouter() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname))

  useEffect(() => {
    function handlePathChange() {
      setPath(normalizePath(window.location.pathname))
    }

    window.addEventListener('popstate', handlePathChange)
    return () => window.removeEventListener('popstate', handlePathChange)
  }, [])

  const isProtectedRoute =
    protectedRoutes.has(path) || path.startsWith('/sources/')

  if (isProtectedRoute && !isMockSessionAuthenticated()) {
    return <App />
  }

  if (path === '/dashboard') {
    return <DashboardPage />
  }

  if (path === '/ledger') {
    return <LedgerPage />
  }

  if (path === '/reports') {
    return <ReportPage />
  }

  if (path === '/sources') {
    return <SourceManagementPage />
  }

  if (path === '/sources/new') {
    return <SourceTypeSelectionPage />
  }

  if (path === '/sources/new/upbit') {
    return <SourceMethodIntroPage methodId="upbit-pdf" />
  }

  if (path === '/sources/new/upbit/upload') {
    return <UpbitPdfRegistrationPage />
  }

  if (path === '/sources/new/wallet') {
    return <SourceMethodIntroPage methodId="evm-wallet" />
  }

  if (path === '/sources/new/wallet/connect') {
    return (
      <Suspense fallback={<p role="status">지갑 연결 화면을 준비하고 있습니다.</p>}>
        <ReownEvmWalletConnectionRoute />
      </Suspense>
    )
  }

  const productRoutes: Partial<Record<string, ProductPageKind>> = {
    '/settings': 'settings',
  }
  const productPage = productRoutes[path]

  if (productPage) {
    return <ProductPage kind={productPage} />
  }

  return <App />
}
