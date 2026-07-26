import { useEffect, useState } from 'react'
import { App } from './App.tsx'
import { DashboardPage } from './features/dashboard/DashboardPage.tsx'
import { LedgerPage } from './features/ledger/LedgerPage.tsx'
import { ReportPage } from './features/reports/ReportPage.tsx'
import {
  ProductPage,
  type ProductPageKind,
} from './features/product/ProductPage.tsx'
import { isMockSessionAuthenticated } from './mocks/session.ts'

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

  if (protectedRoutes.has(path) && !isMockSessionAuthenticated()) {
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

  const productRoutes: Partial<Record<string, ProductPageKind>> = {
    '/settings': 'settings',
    '/sources': 'sources',
  }
  const productPage = productRoutes[path]

  if (productPage) {
    return <ProductPage kind={productPage} />
  }

  return <App />
}
