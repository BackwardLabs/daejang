import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ProductPage } from './ProductPage.tsx'

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
  })
})
