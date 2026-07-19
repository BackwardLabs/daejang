import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App.tsx'

describe('App', () => {
  it('renders the onboarding scaffold and MVP data sources', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { name: '첫 데이터 수집까지 세 단계' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Upbit CSV' })).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'EVM 지갑 주소' }),
    ).toBeInTheDocument()
  })
})
