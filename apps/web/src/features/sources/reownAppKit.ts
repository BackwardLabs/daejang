import { createAppKit, type AppKit } from '@reown/appkit/react'
import { EthersAdapter } from '@reown/appkit-adapter-ethers'
import { evmWalletNetworks } from './evmNetworks.ts'

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID?.trim()

export const isReownAppKitConfigured = Boolean(projectId)

function initializeReownAppKit(): AppKit | null {
  if (!projectId) {
    return null
  }

  const origin = window.location.origin

  return createAppKit({
    adapters: [new EthersAdapter()],
    features: {
      analytics: false,
    },
    metadata: {
      name: 'Daejang',
      description: '디지털 자산 기록을 검토 가능한 장부로 연결합니다.',
      url: origin,
      icons: [`${origin}/daejang-app-icon.png`],
    },
    networks: evmWalletNetworks,
    projectId,
    themeMode: 'light',
  })
}

export const reownAppKit = initializeReownAppKit()
