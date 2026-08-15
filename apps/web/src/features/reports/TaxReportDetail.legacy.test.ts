import { describe, expect, it } from 'vitest'

import { shouldShowLegacyMachineDetails } from './TaxReportDetail.tsx'

describe('legacy report public display', () => {
  it('keeps the raw legacy trace surface out of non-localhost user sessions', () => {
    expect(shouldShowLegacyMachineDetails('daejang.backwardlabs.io')).toBe(false)
    expect(shouldShowLegacyMachineDetails('127.0.0.1')).toBe(false)
    expect(shouldShowLegacyMachineDetails(undefined)).toBe(false)
    expect(shouldShowLegacyMachineDetails('localhost')).toBe(true)
  })
})
