import { useEffect, useState } from 'react'
import {
  consumeOnboardingReturn,
  navigateTo,
  readPublicPath,
  type PublicPath,
} from './auth/navigation.ts'
import { LoginPage } from './pages/auth/LoginPage.tsx'
import {
  OnboardingFlow,
  type OnboardingScreen,
} from './pages/auth/OnboardingFlow.tsx'
import { LandingPage } from './pages/landing/LandingPage.tsx'
import {
  NotFoundPage,
  PrivacyPage,
  SupportPage,
  TermsPage,
} from './pages/public/PublicPages.tsx'

const pageTitles: Record<PublicPath, string> = {
  '/': 'Daejang | 디지털 자산 기록을 한곳에서',
  '/login': '로그인 | Daejang',
  '/terms': '서비스 이용약관 | Daejang',
  '/privacy': '개인정보 처리방침 | Daejang',
  '/support': '고객지원 | Daejang',
}

export function App() {
  const [returnedFromSignup] = useState(() => consumeOnboardingReturn())
  const [path, setPath] = useState<PublicPath | null>(() => readPublicPath())
  const [onboardingVisible, setOnboardingVisible] = useState(returnedFromSignup)
  const [onboardingScreen, setOnboardingScreen] = useState<OnboardingScreen>(
    returnedFromSignup ? 'consent' : 'method',
  )
  const [onboardingKey, setOnboardingKey] = useState(0)

  useEffect(() => {
    const onPopState = () => {
      const returned = consumeOnboardingReturn()
      const nextPath = readPublicPath()
      setPath(nextPath)
      if (returned) {
        setOnboardingVisible(true)
        setOnboardingScreen('consent')
        setOnboardingKey((current) => current + 1)
      } else {
        setOnboardingVisible(false)
      }
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.title = onboardingVisible
      ? '계정 만들기 | Daejang'
      : path
        ? pageTitles[path]
        : '페이지를 찾을 수 없음 | Daejang'
  }, [onboardingVisible, path])

  const navigatePublic = (nextPath: PublicPath) => {
    navigateTo(nextPath)
    setPath(nextPath)
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(false)
  }

  const goHome = () => {
    navigateTo('/')
    setPath('/')
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(false)
  }

  const exitOnboarding = () => {
    setOnboardingVisible(false)
    setOnboardingKey((current) => current + 1)
    navigateTo('/')
    setPath('/')
  }

  const startOnboarding = () => {
    navigateTo('/')
    setPath('/')
    setOnboardingScreen('method')
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(true)
  }

  const openLogin = () => {
    setOnboardingVisible(false)
    setOnboardingKey((current) => current + 1)
    navigateTo('/login')
    setPath('/login')
  }

  const continueAfterLogin = (nextPath: string) => {
    if (nextPath === '/?onboarding=terms') {
      window.history.replaceState(null, '', nextPath)
      consumeOnboardingReturn()
      setPath('/')
      setOnboardingScreen('consent')
      setOnboardingKey((current) => current + 1)
      setOnboardingVisible(true)
      return
    }

    const safePath =
      nextPath.startsWith('/') && !nextPath.startsWith('//')
        ? nextPath
        : '/dashboard'
    window.location.assign(safePath)
  }

  const publicPage =
    path === '/login' ? (
      <LoginPage
        onHome={exitOnboarding}
        onSignup={startOnboarding}
        onNavigate={navigatePublic}
        onAuthenticated={continueAfterLogin}
      />
    ) : path === '/terms' ? (
      <TermsPage onHome={goHome} onNavigate={navigatePublic} />
    ) : path === '/privacy' ? (
      <PrivacyPage onHome={goHome} onNavigate={navigatePublic} />
    ) : path === '/support' ? (
      <SupportPage onHome={goHome} onNavigate={navigatePublic} />
    ) : path === null ? (
      <NotFoundPage onHome={exitOnboarding} onNavigate={navigatePublic} />
    ) : (
      <LandingPage
        onLogin={openLogin}
        onStart={startOnboarding}
        onNavigate={navigatePublic}
      />
    )

  return (
    <>
      {onboardingVisible ? (
        <OnboardingFlow
          key={onboardingKey}
          initialScreen={onboardingScreen}
          onAuthenticated={continueAfterLogin}
          onExit={exitOnboarding}
          onLogin={openLogin}
          onNavigate={navigatePublic}
        />
      ) : publicPage}
    </>
  )
}
