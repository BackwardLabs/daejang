import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'
import { SourceFlowLayout } from './SourceFlowLayout.tsx'

export function SourceManagementPage() {
  return (
    <SourceFlowLayout
      description="거래내역서와 지갑 연결을 한곳에서 관리합니다."
      title="데이터 소스 관리"
    >
      <section
        className="source-summary-card"
        aria-labelledby="connected-source-title"
      >
        <div>
          <h2 id="connected-source-title">연결된 데이터 소스</h2>
          <p>현재 연결된 소스 0개</p>
        </div>
        <a className="source-primary-action" href="/app/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </a>
      </section>

      <section className="source-empty-state" aria-labelledby="source-empty-title">
        <div className="source-empty-state__logos" aria-hidden="true">
          <img src={upbitLogo} alt="" />
          <img src={ethereumDiamond} alt="" />
        </div>
        <h2 id="source-empty-title">아직 연결된 데이터 소스가 없어요</h2>
        <p>
          Upbit 거래내역서 PDF를 등록하거나 EVM Wallet을 연결하면
          <br />
          선택한 조회 기간의 거래 수집을 시작할 수 있습니다.
        </p>
        <div className="source-method-chips" aria-label="지원 데이터 소스">
          <span className="source-chip source-chip--upbit">Upbit PDF</span>
          <span className="source-chip source-chip--evm">EVM Wallet</span>
        </div>
        <a className="source-primary-action" href="/app/sources/new">
          데이터 소스 추가 <span aria-hidden="true">→</span>
        </a>
        <div className="source-processing-note" role="note">
          <strong>등록 완료와 거래 처리 완료는 달라요</strong>
          <span>
            등록 후 조회 기간과 예상 거래를 확인해야 실제 수집을 시작할 수
            있습니다.
          </span>
        </div>
      </section>

      <p className="source-footer-note">
        각 데이터 소스의 연결 해제와 거래 데이터 삭제는 별도로 관리됩니다.
      </p>
    </SourceFlowLayout>
  )
}
