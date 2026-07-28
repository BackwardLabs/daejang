import { useEffect, useState } from 'react'

import {
  getSourceCapabilities,
  type SourceCapabilities,
} from './sourceApi.ts'

const unavailableCapabilities: SourceCapabilities = {
  upbitPdf: {
    registrationEnabled: false,
    encryptedPdfSupported: false,
  },
}

export function useSourceCapabilities() {
  const [capabilities, setCapabilities] = useState(unavailableCapabilities)

  useEffect(() => {
    const controller = new AbortController()
    void getSourceCapabilities(controller.signal)
      .then(setCapabilities)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setCapabilities(unavailableCapabilities)
        }
      })
    return () => controller.abort()
  }, [])

  return capabilities
}
