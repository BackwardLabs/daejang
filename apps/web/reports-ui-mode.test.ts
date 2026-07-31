import { describe, expect, it } from 'vitest'

import {
  reportsPageEntry,
  resolveReportsUiMode,
} from './reports-ui-mode.ts'

describe('reports UI mode', () => {
  it('defaults to the product entry when the mode is not configured', () => {
    expect(resolveReportsUiMode(undefined)).toBe('product')
    expect(reportsPageEntry('product')).toContain('ProductReportPage.tsx')
  })

  it('selects the isolated GIWA-28 demo entry explicitly', () => {
    expect(resolveReportsUiMode('giwa28-demo')).toBe('giwa28-demo')
    expect(reportsPageEntry('giwa28-demo')).toContain(
      'Giwa28DemoReportPage.tsx',
    )
  })

  it.each(['', 'demo', 'live', 'PRODUCT', ' product '])(
    'rejects unsupported mode %j',
    (configuredMode) => {
      expect(() => resolveReportsUiMode(configuredMode)).toThrow(
        'VITE_REPORTS_UI_MODE must be one of: product, giwa28-demo',
      )
    },
  )
})
