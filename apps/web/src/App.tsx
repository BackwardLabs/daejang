import { useEffect, useRef, useState } from 'react'
import {
  getAuthCapabilities,
  type AuthCapabilities,
  type EmailLoginResponse,
} from './auth/api.ts'
import {
  bootstrapSession,
  setCurrentUser,
  type SessionStatus,
} from './auth/session-store.ts'
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

function canSignup(capabilities: AuthCapabilities) {
  return capabilities.signup.enabled &&
    (capabilities.signup.methods.email ||
      capabilities.signup.methods.oauthProviders.length > 0)
}

const pageTitles: Record<PublicPath, string> = {
  '/': 'Daejang | 디지털 자산 기록을 한곳에서',
  '/login': '로그인 | Daejang',
  '/terms': '서비스 이용약관 | Daejang',
  '/privacy': '개인정보 처리방침 | Daejang',
  '/support': '고객지원 | Daejang',
}

export function App({
  sessionStatus = 'anonymous',
}: {
  sessionStatus?: SessionStatus
}) {
  const [returnedFromSignup] = useState(() => consumeOnboardingReturn())
  const [path, setPath] = useState<PublicPath | null>(() => readPublicPath())
  const [authCapabilities, setAuthCapabilities] = useState<AuthCapabilities>()
  const [onboardingVisible, setOnboardingVisible] = useState(false)
  const [onboardingScreen, setOnboardingScreen] = useState<OnboardingScreen>(
    returnedFromSignup ? 'consent' : 'entry',
  )
  const [onboardingEmail, setOnboardingEmail] = useState('')
  const [onboardingKey, setOnboardingKey] = useState(0)
  const startRoutePending = useRef(false)
  const signupAvailable = authCapabilities ? canSignup(authCapabilities) : false

  useEffect(() => {
    let active = true
    void getAuthCapabilities()
      .then((capabilities) => {
        if (!active) return
        setAuthCapabilities(capabilities)
        if (returnedFromSignup && canSignup(capabilities)) {
          setOnboardingScreen('consent')
          setOnboardingVisible(true)
        }
      })
      .catch(() => {
        if (active) setAuthCapabilities(undefined)
      })
    return () => {
      active = false
    }
  }, [returnedFromSignup])

  useEffect(() => {
    const onPopState = () => {
      const returned = consumeOnboardingReturn()
      const nextPath = readPublicPath()
      setPath(nextPath)
      if (returned && signupAvailable) {
        setOnboardingVisible(true)
        setOnboardingScreen('consent')
        setOnboardingKey((current) => current + 1)
      } else {
        setOnboardingVisible(false)
      }
    }

    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [signupAvailable])

  useEffect(() => {
    document.title = onboardingVisible
      ? onboardingScreen === 'entry'
        ? '시작하기 | Daejang'
        : '계정 만들기 | Daejang'
      : path
        ? pageTitles[path]
        : '페이지를 찾을 수 없음 | Daejang'
  }, [onboardingScreen, onboardingVisible, path])

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

  const showAuthChoice = () => {
    navigateTo('/')
    setPath('/')
    setOnboardingScreen('entry')
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(true)
  }

  const openAuthChoice = () => {
    const continueFromStart = (status: SessionStatus) => {
      if (status === 'authenticated') {
        navigateTo('/dashboard')
        return
      }
      showAuthChoice()
    }

    if (sessionStatus === 'unknown' || sessionStatus === 'checking') {
      if (startRoutePending.current) return
      startRoutePending.current = true
      void bootstrapSession()
        .then(({ status }) => continueFromStart(status))
        .finally(() => {
          startRoutePending.current = false
        })
      return
    }

    continueFromStart(sessionStatus)
  }

  const startOnboarding = () => {
    if (!signupAvailable) return
    navigateTo('/')
    setPath('/')
    setOnboardingEmail('')
    setOnboardingScreen('method')
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(true)
  }

  const startEmailOnboarding = async (email: string) => {
    let capabilities = authCapabilities
    if (!capabilities) {
      try {
        capabilities = await getAuthCapabilities()
        setAuthCapabilities(capabilities)
      } catch {
        return false
      }
    }
    if (!canSignup(capabilities) || !capabilities.signup.methods.email) {
      return false
    }
    navigateTo('/')
    setPath('/')
    setOnboardingEmail(email)
    setOnboardingScreen('email')
    setOnboardingKey((current) => current + 1)
    setOnboardingVisible(true)
    return true
  }

  const openLogin = () => {
    setOnboardingVisible(false)
    setOnboardingKey((current) => current + 1)
    navigateTo('/login')
    setPath('/login')
  }

  const continueAfterLogin = async (response: EmailLoginResponse) => {
    const { nextPath } = response
    if (nextPath === '/?onboarding=terms') {
      let capabilities = authCapabilities
      if (!capabilities) {
        try {
          capabilities = await getAuthCapabilities()
          setAuthCapabilities(capabilities)
        } catch {
          capabilities = undefined
        }
      }
      if (!capabilities || !canSignup(capabilities)) {
        setOnboardingVisible(false)
        navigateTo('/login')
        setPath('/login')
        return
      }
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
    if (response.status !== 'authenticated') return

    setCurrentUser(response.user)
    navigateTo(safePath, true)
  }

  const publicPage =
    path === '/login' ? (
      <LoginPage
        onHome={exitOnboarding}
        onSignup={startOnboarding}
        onSignupWithEmail={startEmailOnboarding}
        onNavigate={navigatePublic}
        onAuthenticated={continueAfterLogin}
        signupAvailable={signupAvailable}
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
        onStart={openAuthChoice}
        onNavigate={navigatePublic}
      />
    )

  return (
    <>
      {onboardingVisible &&
      (onboardingScreen === 'entry' || (signupAvailable && authCapabilities)) ? (
        <OnboardingFlow
          key={onboardingKey}
          initialEmail={onboardingEmail}
          initialScreen={onboardingScreen}
          onAuthenticated={continueAfterLogin}
          onExit={exitOnboarding}
          onLogin={openLogin}
          onNavigate={navigatePublic}
          signupMethods={
            authCapabilities?.signup.methods ?? {
              email: false,
              oauthProviders: [],
            }
          }
          identityVerificationRequired={
            authCapabilities?.signup.identityVerificationRequired ?? true
          }
        />
      ) : publicPage}
    </>
  )
}
