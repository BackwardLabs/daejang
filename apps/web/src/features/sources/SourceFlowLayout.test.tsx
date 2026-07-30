import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'

describe('SourceFlowLayout', () => {
  it('uses and updates the shared browser-local year preference', () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })

    const { unmount } = render(
      <SourceFlowLayout
        description="테스트 설명"
        title="테스트 소스"
      >
        <p>본문</p>
      </SourceFlowLayout>,
    )

    const period = screen.getByRole('combobox', { name: '조회 기간' })
    expect(period).toHaveValue('2025')
    fireEvent.change(period, { target: { value: '2026' } })
    expect(loadAppPreferences().year).toBe('2026')

    unmount()
    render(
      <SourceFlowLayout
        description="다음 화면 설명"
        title="다음 소스 화면"
      >
        <p>다음 본문</p>
      </SourceFlowLayout>,
    )

    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
  })
})
