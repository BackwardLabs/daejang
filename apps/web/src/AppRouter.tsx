import { lazy, Suspense, useEffect, useState } from 'react'
import { App } from './App.tsx'
import type { ProductPageKind } from './features/product/ProductPage.tsx'
import { loadCurrentUser } from './api/authApi.ts'

const ReownEvmWalletConnectionRoute = lazy(async () => {
  const module = await import(
    './features/sources/ReownEvmWalletConnectionRoute.tsx'
  )

  return { default: module.ReownEvmWalletConnectionRoute }
})
const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage.tsx').then((module) => ({ default: module.DashboardPage })))
const LedgerPage = lazy(() => import('./features/ledger/LedgerPage.tsx').then((module) => ({ default: module.LedgerPage })))
const ReportPage = lazy(() => import('./features/reports/ReportPage.tsx').then((module) => ({ default: module.ReportPage })))
const X402PaymentPage = lazy(() => import('./features/payments/X402PaymentPage.tsx').then((module) => ({ default: module.X402PaymentPage })))
const SourceManagementPage = lazy(() => import('./features/sources/SourceManagementPage.tsx').then((module) => ({ default: module.SourceManagementPage })))
const SourceMethodIntroPage = lazy(() => import('./features/sources/SourceMethodIntroPage.tsx').then((module) => ({ default: module.SourceMethodIntroPage })))
const SourceTypeSelectionPage = lazy(() => import('./features/sources/SourceTypeSelectionPage.tsx').then((module) => ({ default: module.SourceTypeSelectionPage })))
const UpbitPdfRegistrationPage = lazy(() => import('./features/sources/UpbitPdfRegistrationPage.tsx').then((module) => ({ default: module.UpbitPdfRegistrationPage })))
const ProductPage = lazy(() => import('./features/product/ProductPage.tsx').then((module) => ({ default: module.ProductPage })))

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
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking')

  useEffect(() => {
    function handlePathChange() {
      setPath(normalizePath(window.location.pathname))
    }

    window.addEventListener('popstate', handlePathChange)
    return () => window.removeEventListener('popstate', handlePathChange)
  }, [])

  const isProtectedRoute =
    protectedRoutes.has(path) || path.startsWith('/reports/') || path.startsWith('/sources/')

  useEffect(() => {
    if (!isProtectedRoute) return
    const controller = new AbortController(); setAuthState('checking')
    void loadCurrentUser(controller.signal).then(() => setAuthState('authenticated')).catch(() => setAuthState('unauthenticated'))
    return () => controller.abort()
  }, [isProtectedRoute, path])

  if (isProtectedRoute && authState === 'checking') return <p role="status">로그인 상태를 확인하고 있습니다.</p>
  if (isProtectedRoute && authState === 'unauthenticated') return <App />

  const pending = <p role="status">화면을 준비하고 있습니다.</p>

  if (path === '/dashboard') return <Suspense fallback={pending}><DashboardPage /></Suspense>

  if (path === '/ledger') {
    return <Suspense fallback={pending}><LedgerPage /></Suspense>
  }

  if (path === '/reports') {
    return <Suspense fallback={pending}><ReportPage /></Suspense>
  }

  if (path === '/reports/x402-payment') {
    return <Suspense fallback={pending}><X402PaymentPage /></Suspense>
  }

  if (path === '/sources') {
    return <Suspense fallback={pending}><SourceManagementPage /></Suspense>
  }

  if (path === '/sources/new') {
    return <Suspense fallback={pending}><SourceTypeSelectionPage /></Suspense>
  }

  if (path === '/sources/new/upbit') {
    return <Suspense fallback={pending}><SourceMethodIntroPage methodId="upbit-pdf" /></Suspense>
  }

  if (path === '/sources/new/upbit/upload') {
    return <Suspense fallback={pending}><UpbitPdfRegistrationPage /></Suspense>
  }

  if (path === '/sources/new/wallet') {
    return <Suspense fallback={pending}><SourceMethodIntroPage methodId="evm-wallet" /></Suspense>
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
    return <Suspense fallback={pending}><ProductPage kind={productPage} /></Suspense>
  }

  return <App />
}
