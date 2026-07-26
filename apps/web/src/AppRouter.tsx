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

const routeAliases: Record<string, string> = {
  '/app/dashboard': '/dashboard',
  '/app/ledger': '/ledger',
  '/app/reports': '/reports',
  '/app/settings': '/settings',
  '/app/sources': '/sources',
  '/features/dashboard': '/dashboard',
  '/features/ledger': '/ledger',
  '/features/reports': '/reports',
}

const protectedRoutes = new Set([
  '/dashboard',
  '/ledger',
  '/reports',
  '/settings',
  '/sources',
])

function resolvePath(pathname: string) {
  const normalized = normalizePath(pathname)

  return routeAliases[normalized] ?? normalized
}

export function AppRouter() {
  const [path, setPath] = useState(() => resolvePath(window.location.pathname))

  useEffect(() => {
    function handlePathChange() {
      const normalized = normalizePath(window.location.pathname)
      const resolved = resolvePath(normalized)

      if (resolved !== normalized) {
        window.history.replaceState({}, '', resolved)
      }

      setPath(resolved)
    }

    handlePathChange()
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
