import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  resetSessionStateForTests,
  setCurrentUser,
} from '../auth/session-store.ts'
import { AppSidebar } from './AppSidebar.tsx'

afterEach(() => {
  resetSessionStateForTests()
})

const renderSidebar = () =>
  render(
    <AppSidebar
      activePage="dashboard"
      year="2027"
      onYearChange={() => undefined}
    />,
  )

describe('AppSidebar', () => {
  it('opens the ledger guide in place and closes it with Escape', () => {
    renderSidebar()
    const guideButton = screen.getByRole('button', {
      name: /장부 만들기 가이드를 확인하세요/,
    })
    guideButton.focus()
    fireEvent.click(guideButton)

    expect(
      screen.getByRole('dialog', { name: '장부 만들기 가이드' }),
    ).toBeInTheDocument()
    expect(screen.getByText('데이터 소스 연결')).toBeInTheDocument()
    expect(screen.getByText('거래 수집 상태 확인')).toBeInTheDocument()
    expect(screen.getByText('보고서 확인')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(
      screen.queryByRole('dialog', { name: '장부 만들기 가이드' }),
    ).not.toBeInTheDocument()
    expect(guideButton).toHaveFocus()
  })

  it('uses the authenticated email and opens a read-only profile overlay', () => {
    setCurrentUser({
      id: '018f47a2-4b1c-7def-8abc-0123456789ab',
      displayName: 'GIWA 사용자',
      email: 'member@example.com',
    })
    renderSidebar()

    const accountButton = screen.getByRole('button', {
      name: /member@example\.com/,
    })
    expect(accountButton).toBeInTheDocument()
    expect(screen.queryByText('GIWA 사용자')).not.toBeInTheDocument()

    fireEvent.click(accountButton)
    const profileDialog = screen.getByRole('dialog', { name: '마이페이지' })
    expect(profileDialog).toBeInTheDocument()
    expect(within(profileDialog).getByText('member@example.com')).toBeInTheDocument()
    expect(within(profileDialog).getByText('아직 설정하지 않았어요')).toBeInTheDocument()
    expect(
      screen.getByText('닉네임 설정 기능은 추후 제공할 예정입니다'),
    ).toBeInTheDocument()
  })

  it('does not expose the internal default display name without an email', () => {
    setCurrentUser({
      id: '018f47a2-4b1c-7def-8abc-0123456789ab',
      displayName: 'GIWA 사용자',
    })
    renderSidebar()

    expect(screen.getByRole('button', { name: /계정개인 장부/ })).toBeInTheDocument()
    expect(screen.queryByText('GIWA 사용자')).not.toBeInTheDocument()
  })
})
