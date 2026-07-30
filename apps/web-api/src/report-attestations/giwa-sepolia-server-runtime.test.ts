import { describe, expect, it } from 'vitest'

import { assertGiwaReportRuntimeNodeVersion } from './giwa-sepolia-server-runtime.js'

describe('GIWA Sepolia report server runtime boundary', () => {
  it.each(['24.18.0', '24.18.7', '24.99.0'])(
    'accepts the supported Node runtime %s',
    (version) => {
      expect(() =>
        assertGiwaReportRuntimeNodeVersion(version),
      ).not.toThrow()
    },
  )

  it.each(['22.12.0', '24.17.9', '25.0.0', 'invalid'])(
    'rejects the unsupported Node runtime %s',
    (version) => {
      expect(() =>
        assertGiwaReportRuntimeNodeVersion(version),
      ).toThrow('>=24.18.0 <25')
    },
  )
})
