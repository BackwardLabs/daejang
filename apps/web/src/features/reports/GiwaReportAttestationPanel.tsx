import { useEffect, useState } from 'react'

import {
  giwaExplorerAddressUrl,
  loadReportAttestationDeployment,
  type ReportAttestationDeployment,
  type ReportAttestationDeploymentReasonCode,
} from './reportAttestationDeploymentApi.ts'

type PanelState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'error' }>
  | Readonly<{
      kind: 'ready'
      deployment: ReportAttestationDeployment
    }>

const reasonLabels: Record<ReportAttestationDeploymentReasonCode, string> = {
  RPC_UNAVAILABLE: 'GIWA Sepolia RPC를 읽을 수 없습니다.',
  CHAIN_ID_MISMATCH: '연결된 네트워크가 GIWA Sepolia가 아닙니다.',
  EAS_CODE_MISSING: 'EAS 컨트랙트 bytecode를 찾지 못했습니다.',
  SCHEMA_REGISTRY_CODE_MISSING:
    'SchemaRegistry 컨트랙트 bytecode를 찾지 못했습니다.',
  REPORT_REGISTRY_CODE_MISSING:
    'ReportRegistryV1 proxy bytecode를 찾지 못했습니다.',
  REPORT_CONSUMER_CODE_MISSING:
    'ReportConsumer 컨트랙트 bytecode를 찾지 못했습니다.',
  EAS_SCHEMA_REGISTRY_MISMATCH:
    'EAS가 가리키는 SchemaRegistry가 설정과 다릅니다.',
  REGISTRY_EAS_MISMATCH:
    'ReportRegistryV1이 가리키는 EAS가 설정과 다릅니다.',
  REGISTRY_SCHEMA_UID_MISMATCH:
    'ReportRegistryV1의 schema UID가 설정과 다릅니다.',
  REGISTRY_EVIDENCE_SCHEMA_DIGEST_MISMATCH:
    'ReportRegistryV1의 evidence schema digest가 설정과 다릅니다.',
  CONSUMER_REGISTRY_MISMATCH:
    'ReportConsumer가 가리키는 ReportRegistryV1이 설정과 다릅니다.',
}

const statusCopy = (
  deployment: Extract<ReportAttestationDeployment, { enabled: true }>,
) => {
  if (deployment.status === 'CONNECTED') {
    return {
      label: '읽기 연결 확인',
      title: 'GIWA Sepolia 배포 연결값을 확인했습니다',
      description:
        'chainId, 컨트랙트 bytecode와 EAS·Registry·Consumer 연결을 읽기 전용으로 확인했습니다. release gate 통과나 개별 장부의 USABLE 판정을 뜻하지는 않습니다.',
    }
  }
  if (deployment.status === 'UNAVAILABLE') {
    return {
      label: 'RPC 조회 불가',
      title: '현재 온체인 상태를 읽지 못했습니다',
      description:
        '배포 주소는 서버에 구성되어 있지만 GIWA Sepolia 조회가 실패했습니다. 안전을 위해 사용 가능한 배포로 간주하지 않습니다.',
    }
  }
  return {
    label: '배포값 불일치',
    title: '서버 설정과 온체인 상태가 일치하지 않습니다',
    description: deployment.reasonCode
      ? reasonLabels[deployment.reasonCode]
      : '배포 연결값을 확인할 수 없습니다.',
  }
}

function DeploymentDetails({
  deployment,
}: {
  deployment: Extract<ReportAttestationDeployment, { enabled: true }>
}) {
  const copy = statusCopy(deployment)
  const addresses = [
    ['EAS', deployment.addresses.eas],
    ['SchemaRegistry', deployment.addresses.schemaRegistry],
    ['ReportRegistryV1 proxy', deployment.addresses.reportRegistryProxy],
    ['ReportConsumer', deployment.addresses.reportConsumer],
  ] as const

  return (
    <>
      <div className="report-attestation-deployment__status">
        <b data-status={deployment.status}>{copy.label}</b>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
      <dl className="report-attestation-deployment__facts">
        {addresses.map(([label, address]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <a
                href={giwaExplorerAddressUrl(address)}
                target="_blank"
                rel="noreferrer"
              >
                <code>{address}</code>
              </a>
            </dd>
          </div>
        ))}
        <div>
          <dt>Schema UID</dt>
          <dd><code>{deployment.schemaUID}</code></dd>
        </div>
        <div>
          <dt>Evidence schema digest</dt>
          <dd><code>{deployment.evidenceSchemaDigest}</code></dd>
        </div>
      </dl>
    </>
  )
}

export function GiwaReportAttestationPanel() {
  const [state, setState] = useState<PanelState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    void loadReportAttestationDeployment(controller.signal)
      .then((deployment) => {
        setState({ kind: 'ready', deployment })
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          setState({ kind: 'error' })
        }
      })
    return () => controller.abort()
  }, [])

  return (
    <details
      className="report-attestation-deployment"
    >
      <summary>
        <span>
          <b>기술 연결 정보</b>
          <small>GIWA Sepolia 컨트랙트·스키마 배포값</small>
        </span>
        <strong>펼쳐보기</strong>
      </summary>
      <div className="report-attestation-deployment__body">
        <header>
          <div>
            <span>GIWA SEPOLIA · READ ONLY</span>
            <h2 id="report-attestation-deployment-title">
              GIWA Sepolia 장부 증명
            </h2>
          </div>
          <p>서버가 고정한 GIWA-28 배포 경계만 조회합니다.</p>
        </header>

        {state.kind === 'loading' ? (
          <p className="report-api-state" role="status">
            GIWA Sepolia 배포 상태를 확인하는 중입니다.
          </p>
        ) : null}
        {state.kind === 'error' ? (
          <div className="report-attestation-deployment__empty" role="alert">
            <b>배포 상태를 확인하지 못했습니다</b>
            <p>
              주소나 온체인 결과를 추정해서 표시하지 않습니다. 현재는 준비
              상태 조회만 가능합니다.
            </p>
          </div>
        ) : null}
        {state.kind === 'ready' && !state.deployment.enabled ? (
          <div className="report-attestation-deployment__empty" role="status">
            <b>GIWA Sepolia 배포 정보가 아직 연결되지 않았습니다</b>
            <p>
              서버에는 조회 전용 영역만 열려 있습니다. 실제 배포 주소를
              등록하기 전까지 SUBMIT·APPROVE·USABLE 결과를 표시하지 않습니다.
            </p>
          </div>
        ) : null}
        {state.kind === 'ready' && state.deployment.enabled ? (
          <DeploymentDetails deployment={state.deployment} />
        ) : null}
      </div>
    </details>
  )
}
