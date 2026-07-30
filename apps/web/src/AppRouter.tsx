import { lazy, Suspense, useEffect, useState, useTransition } from 'react'
import { App } from './App.tsx'
import {
  bootstrapSession,
  useSession,
} from './auth/session-store.ts'
import { navigateTo } from './auth/navigation.ts'
import { DashboardPage } from './features/dashboard/DashboardPage.tsx'
import type { ProductPageKind } from './features/product/ProductPage.tsx'

const loadLedgerPage = () => import('./features/ledger/LedgerPage.tsx')
const loadReportPage = () => import('./features/reports/ReportPage.tsx')
const loadSourceManagementPage = () =>
  import('./features/sources/SourceManagementPage.tsx')
const loadSourceMethodIntroPage = () =>
  import('./features/sources/SourceMethodIntroPage.tsx')
const loadSourceTypeSelectionPage = () =>
  import('./features/sources/SourceTypeSelectionPage.tsx')
const loadUpbitPdfRegistrationPage = () =>
  import('./features/sources/UpbitPdfRegistrationPage.tsx')
const loadProductPage = () => import('./features/product/ProductPage.tsx')

const LedgerPage = lazy(() =>
  loadLedgerPage().then((module) => ({ default: module.LedgerPage })))
const ReportPage = lazy(() =>
  loadReportPage().then((module) => ({ default: module.ReportPage })))
const SourceManagementPage = lazy(() =>
  loadSourceManagementPage().then((module) => ({
    default: module.SourceManagementPage,
  })))
const SourceMethodIntroPage = lazy(() =>
  loadSourceMethodIntroPage().then((module) => ({
    default: module.SourceMethodIntroPage,
  })))
const SourceTypeSelectionPage = lazy(() =>
  loadSourceTypeSelectionPage().then((module) => ({
    default: module.SourceTypeSelectionPage,
  })))
const UpbitPdfRegistrationPage = lazy(() =>
  loadUpbitPdfRegistrationPage().then((module) => ({
    default: module.UpbitPdfRegistrationPage,
  })))
const ProductPage = lazy(() =>
  loadProductPage().then((module) => ({ default: module.ProductPage })))

const routePreloaders: Record<string, () => Promise<unknown>> = {
  '/ledger': loadLedgerPage,
  '/reports': loadReportPage,
  '/settings': loadProductPage,
  '/sources': loadSourceManagementPage,
  '/sources/new': loadSourceTypeSelectionPage,
  '/sources/new/upbit': loadSourceMethodIntroPage,
  '/sources/new/upbit/upload': loadUpbitPdfRegistrationPage,
}

function preloadRoute(pathname: string) {
  const preload = routePreloaders[normalizePath(pathname)]
  if (preload) void preload().catch(() => undefined)
}

function normalizePath(pathname: string) {
  const normalized = pathname.replace(/\/+$/, '')

  if (
    normalized === '/sources/new/wallet' ||
    normalized === '/sources/new/wallet/connect'
  ) {
    return '/sources/new'
  }

  return normalized || '/'
}

function internalAnchor(target: EventTarget | null) {
  if (!(target instanceof Element)) return undefined
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor || (anchor.target && anchor.target !== '_self')) return undefined
  if (anchor.hasAttribute('download') || anchor.relList.contains('external')) {
    return undefined
  }

  const url = new URL(anchor.href, window.location.href)
  return url.origin === window.location.origin ? url : undefined
}

const protectedRoutes = new Set([
  '/dashboard',
  '/ledger',
  '/reports',
  '/settings',
  '/sources',
])

function SessionLoadingState() {
  return (
    <main
      className="session-loading"
      role="status"
      aria-label="페이지를 불러오는 중"
    >
      <img src="/daejang-logo.svg" alt="" />
      <span className="session-loading__bar" aria-hidden="true" />
    </main>
  )
}

export function AppRouter() {
  const [path, setPath] = useState(() => normalizePath(window.location.pathname))
  const [, startRouteTransition] = useTransition()
  const session = useSession()
  const isProtectedRoute =
    protectedRoutes.has(path) || path.startsWith('/sources/')
  const isPublicEntry = path === '/' || path === '/login'

  useEffect(() => {
    const rawPath = window.location.pathname.replace(/\/+$/, '') || '/'
    const canonicalPath = normalizePath(rawPath)
    if (canonicalPath !== rawPath) {
      navigateTo(canonicalPath, true)
    }
  }, [])

  useEffect(() => {
    function handlePathChange() {
      const nextPath = normalizePath(window.location.pathname)
      preloadRoute(nextPath)
      startRouteTransition(() => {
        setPath(nextPath)
      })
    }

    function handleRouteIntent(event: Event) {
      const url = internalAnchor(event.target)
      if (url) preloadRoute(url.pathname)
    }

    window.addEventListener('popstate', handlePathChange)
    document.addEventListener('pointerover', handleRouteIntent)
    document.addEventListener('focusin', handleRouteIntent)
    return () => {
      window.removeEventListener('popstate', handlePathChange)
      document.removeEventListener('pointerover', handleRouteIntent)
      document.removeEventListener('focusin', handleRouteIntent)
    }
  }, [startRouteTransition])

  useEffect(() => {
    preloadRoute(path)
  }, [path])

  useEffect(() => {
    if (
      session.status === 'unknown' ||
      session.status === 'checking'
    ) {
      void bootstrapSession()
    }
  }, [session.status])

  useEffect(() => {
    if (session.status === 'authenticated' && isPublicEntry) {
      navigateTo('/dashboard', true)
      return
    }
    if (session.status === 'anonymous' && isProtectedRoute) {
      navigateTo('/login', true)
    }
  }, [isProtectedRoute, isPublicEntry, session.status])

  const productRoutes: Partial<Record<string, ProductPageKind>> = {
    '/settings': 'settings',
  }
  const productPage = productRoutes[path]
  if (isProtectedRoute) {
    if (session.status === 'error') {
      return (
        <main className="session-state" role="alert">
          <h1>로그인 상태를 확인하지 못했습니다</h1>
          <p>네트워크 연결을 확인한 뒤 다시 시도해 주세요</p>
          <button
            type="button"
            onClick={() => void bootstrapSession({ retry: true })}
          >
            다시 시도
          </button>
        </main>
      )
    }

    if (session.status === 'anonymous') {
      return <SessionLoadingState />
    }

    let protectedPage: React.ReactNode

    if (path === '/dashboard') protectedPage = <DashboardPage />
    else if (path === '/ledger') protectedPage = <LedgerPage />
    else if (path === '/reports') protectedPage = <ReportPage />
    else if (path === '/sources') protectedPage = <SourceManagementPage />
    else if (path === '/sources/new') protectedPage = <SourceTypeSelectionPage />
    else if (path === '/sources/new/upbit') {
      protectedPage = <SourceMethodIntroPage methodId="upbit-pdf" />
    } else if (path === '/sources/new/upbit/upload') {
      protectedPage = <UpbitPdfRegistrationPage />
    } else if (productPage) {
      protectedPage = <ProductPage kind={productPage} />
    }

    return (
      <Suspense fallback={<SessionLoadingState />}>
        {protectedPage}
      </Suspense>
    )
  }

  if (isPublicEntry && session.status === 'authenticated') {
    return <SessionLoadingState />
  }

  return <App />
}
