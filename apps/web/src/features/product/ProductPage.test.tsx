import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  loadAppPreferences,
  saveAppPreferences,
} from '../../preferences/appPreferences.ts'
import { ProductPage } from './ProductPage.tsx'

afterEach(() => vi.restoreAllMocks())

describe('ProductPage', () => {
  it('renders only the settings surface without fake source rows', () => {
    render(<ProductPage kind="settings" />)

    expect(screen.getByText('계정')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '설정' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: '대시보드' })).not.toHaveAttribute(
      'aria-current',
    )
    expect(
      screen.getByRole('heading', { name: '장부 기본 설정' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Upbit')).not.toBeInTheDocument()
    expect(screen.queryByText(/0x8f/)).not.toBeInTheDocument()
    expect(
      screen.getByText(/현재 사용 중인 브라우저에 저장되며/),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('option', {
        name: 'USD · 미국 달러 (환율 변환 준비 중)',
      }),
    ).toBeDisabled()
  })

  it('saves the selected default year to the shared browser preference', () => {
    saveAppPreferences({ currency: 'KRW', year: '2025' })
    render(<ProductPage kind="settings" />)

    const defaultYear = screen.getByRole('combobox', {
      name: '기본 조회 연도',
    })
    expect(defaultYear).toHaveValue('2025')
    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2025',
    )

    fireEvent.change(defaultYear, { target: { value: '2026' } })
    expect(loadAppPreferences().year).toBe('2025')

    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }))

    expect(
      screen.getByText('이 브라우저에 설정을 저장했습니다.'),
    ).toHaveAttribute('role', 'status')
    expect(loadAppPreferences()).toEqual({
      currency: 'KRW',
      year: '2026',
    })
    expect(screen.getByRole('combobox', { name: '조회 기간' })).toHaveValue(
      '2026',
    )
  })

  it('shows an error instead of claiming success when browser storage rejects the save', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    render(<ProductPage kind="settings" />)

    fireEvent.click(screen.getByRole('button', { name: '설정 저장' }))

    expect(
      screen.getByText(/설정을 저장하지 못했습니다/),
    ).toHaveAttribute('role', 'alert')
    expect(
      screen.queryByText('이 브라우저에 설정을 저장했습니다.'),
    ).not.toBeInTheDocument()
  })
})
