import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GiwaReportAttestationPanel } from './GiwaReportAttestationPanel.tsx'

const easAddress = '0x4200000000000000000000000000000000000021'
const schemaRegistryAddress =
  '0x4200000000000000000000000000000000000020'
const reportRegistryProxyAddress =
  '0x1111111111111111111111111111111111111111'
const reportConsumerAddress =
  '0x2222222222222222222222222222222222222222'

const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('GiwaReportAttestationPanel', () => {
  it('stays visible without inventing a deployment when capability is disabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          enabled: false,
          network: 'eip155:91342',
          mode: 'READ_ONLY',
          status: 'NOT_CONFIGURED',
        }),
      ),
    )

    render(<GiwaReportAttestationPanel />)

    expect(
      screen.getByRole('heading', { name: 'GIWA Sepolia 장부 증명' }),
    ).toBeInTheDocument()
    expect(
      await screen.findByText(
        'GIWA Sepolia 배포 정보가 아직 연결되지 않았습니다',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText('USABLE')).not.toBeInTheDocument()
  })

  it('shows configured addresses only with a bounded read-connection claim', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          enabled: true,
          network: 'eip155:91342',
          mode: 'READ_ONLY',
          status: 'CONNECTED',
          reasonCode: null,
          addresses: {
            eas: easAddress,
            schemaRegistry: schemaRegistryAddress,
            reportRegistryProxy: reportRegistryProxyAddress,
            reportConsumer: reportConsumerAddress,
          },
          schemaUID: `0x${'a'.repeat(64)}`,
          evidenceSchemaDigest: `0x${'b'.repeat(64)}`,
        }),
      ),
    )

    render(<GiwaReportAttestationPanel />)

    expect(
      await screen.findByText('GIWA Sepolia 배포 연결값을 확인했습니다'),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/release gate 통과나 개별 장부의 USABLE 판정/),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: reportRegistryProxyAddress }))
      .toHaveAttribute(
        'href',
        `https://sepolia-explorer.giwa.io/address/${reportRegistryProxyAddress}`,
      )
  })

  it('fails closed when the authenticated capability cannot be read', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('server unavailable')
      }),
    )

    render(<GiwaReportAttestationPanel />)

    expect(
      await screen.findByText('배포 상태를 확인하지 못했습니다'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
