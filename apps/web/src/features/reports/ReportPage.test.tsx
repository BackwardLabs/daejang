import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportPage } from './ReportPage.tsx'

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))) })
describe('ReportPage', () => { it('shows an honest empty state', async () => { render(<ReportPage />); expect(await screen.findByRole('heading', { name: '아직 발행된 보고서가 없습니다' })).toBeInTheDocument() }) })
