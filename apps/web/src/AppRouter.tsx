import { lazy, Suspense, useEffect, useState } from 'react'
import { App } from './App.tsx'
import { getCurrentUser, WebApiError } from './auth/api.ts'
import {
  getCurrentUserSnapshot,
  setCurrentUser,
  useCurrentUser,
} from './auth/session-store.ts'
import type { ProductPageKind } from './features/product/ProductPage.tsx'

const ReownEvmWalletConnectionRoute = lazy(async () => {
  const module = await import(
    './features/sources/ReownEvmWalletConnectionRoute.tsx'
  )

  return { default: module.ReownEvmWalletConnectionRoute }
})
const DashboardPage = lazy(() => import('./features/dashboard/DashboardPage.tsx').then((module) => ({ default: module.DashboardPage })))
const LedgerPage = lazy(() => import('./features/ledger/LedgerPage.tsx').then((module) => ({ default: module.LedgerPage })))
const ReportPage = lazy(() => import('./features/reports/ReportPage.tsx').then((module) => ({ default: module.ReportPage })))
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

function SessionGate({ children }: { children: React.ReactNode }) {
  const user = useCurrentUser()
  const [state, setState] = useState<'checking' | 'ready' | 'anonymous' | 'error'>(
    () => (getCurrentUserSnapshot() ? 'ready' : 'checking'),
  )

  const checkSession = async () => {
    setState('checking')
    try {
      const response = await getCurrentUser()
      setCurrentUser(response.user)
      setState('ready')
    } catch (caught) {
      if (caught instanceof WebApiError && caught.status === 401) {
        setCurrentUser(null)
        window.history.replaceState(null, '', '/login')
        setState('anonymous')
        return
      }
      setState('error')
    }
  }

  useEffect(() => {
    if (user) {
      setState('ready')
      return
    }
    void checkSession()
  }, [user])

  if (state === 'ready' && user) return children
  if (state === 'anonymous') return <App />

  if (state === 'error') {
    return (
      <main className="session-state" role="alert">
        <h1>로그인 상태를 확인하지 못했습니다</h1>
        <p>네트워크 연결을 확인한 뒤 다시 시도해 주세요</p>
        <button type="button" onClick={checkSession}>다시 시도</button>
      </main>
    )
  }

  return <p className="session-state" role="status">로그인 상태를 확인하는 중</p>
}

function PublicEntry({ onRedirect }: { onRedirect: () => void }) {
  const user = useCurrentUser()
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let active = true

    const redirectToDashboard = () => {
      window.history.replaceState(null, '', '/dashboard')
      onRedirect()
    }

    if (user) {
      redirectToDashboard()
      return
    }

    void getCurrentUser()
      .then(({ user: currentUser }) => {
        if (!active) return
        setCurrentUser(currentUser)
        redirectToDashboard()
      })
      .catch(() => {
        if (active) setChecking(false)
      })

    return () => {
      active = false
    }
  }, [user])

  return checking ? (
    <p className="session-state" role="status">로그인 상태를 확인하는 중</p>
  ) : (
    <App />
  )
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

  const isProtectedRoute =
    protectedRoutes.has(path) || path.startsWith('/sources/')

  const productRoutes: Partial<Record<string, ProductPageKind>> = {
    '/settings': 'settings',
  }
  const productPage = productRoutes[path]
  const pending = <p role="status">화면을 준비하고 있습니다</p>

  if (isProtectedRoute) {
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
    } else if (path === '/sources/new/wallet') {
      protectedPage = <SourceMethodIntroPage methodId="evm-wallet" />
    } else if (path === '/sources/new/wallet/connect') {
      protectedPage = (
        <ReownEvmWalletConnectionRoute />
      )
    } else if (productPage) {
      protectedPage = <ProductPage kind={productPage} />
    }

    return (
      <SessionGate>
        <Suspense fallback={pending}>{protectedPage}</Suspense>
      </SessionGate>
    )
  }

  if (path === '/' || path === '/login') {
    return <PublicEntry onRedirect={() => setPath('/dashboard')} />
  }

  return <App />
}
