import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProductPage } from './ProductPage.tsx'

describe('ProductPage', () => {
  it('connects and disconnects the mock Base source', () => {
    render(<ProductPage kind="sources" />)

    expect(screen.getByText('계정')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '거래소·지갑' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: '대시보드' })).not.toHaveAttribute(
      'aria-current',
    )
    const connectButton = screen.getByRole('button', { name: '소스 연결' })
    fireEvent.click(connectButton)
    expect(screen.getByRole('button', { name: '연결 해제' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '연결 해제' }))
    expect(screen.getByRole('button', { name: '소스 연결' })).toBeInTheDocument()
  })
})
