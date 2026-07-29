export type PublicPath =
  | '/'
  | '/login'
  | '/signup/terms'
  | '/terms'
  | '/privacy'
  | '/support'

const publicPaths = new Set<PublicPath>([
  '/',
  '/login',
  '/signup/terms',
  '/terms',
  '/privacy',
  '/support',
])

function normalizePath(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.slice(0, -1)
  }

  return pathname
}

export function readPublicPath(): PublicPath | null {
  const rawPath = window.location.pathname
  const path = normalizePath(rawPath)

  if (
    path === '/' &&
    new URL(window.location.href).searchParams.get('onboarding') === 'terms'
  ) {
    window.history.replaceState(null, '', '/signup/terms')
    return '/signup/terms'
  }

  if (path === '/signup') {
    window.history.replaceState(null, '', '/')
    return '/'
  }

  if (!publicPaths.has(path as PublicPath)) return null

  if (path !== rawPath || window.location.search) {
    window.history.replaceState(null, '', path)
  }

  return path as PublicPath
}

export function navigateTo(path: string, replace = false) {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Internal navigation requires a root-relative path')
  }
  const method = replace ? 'replaceState' : 'pushState'
  window.history[method](null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
