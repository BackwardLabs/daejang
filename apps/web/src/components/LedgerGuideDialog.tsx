import { AppDialog } from './AppDialog.tsx'

const guideSteps = [
  {
    title: '데이터 소스 연결',
    description:
      'Upbit 거래내역서 PDF를 등록하거나 읽기 전용 EVM Wallet을 연결합니다',
  },
  {
    title: '수집 범위 확인',
    description:
      '과세연도와 거래 수집 기간을 확인합니다. 지갑 연결은 소유권 확인 서명만 요청하며 자산 이동 권한은 요구하지 않습니다',
  },
  {
    title: '거래 수집 상태 확인',
    description:
      '등록한 범위로 거래 수집을 시작합니다. 거래소·지갑 화면에서 진행 상태를 확인하고 실패한 작업은 원인을 확인한 뒤 다시 시작할 수 있습니다',
  },
  {
    title: '장부와 검토 항목 확인',
    description:
      '거래 장부에서 수집된 거래를 확인하고 검토가 필요한 항목에 거래 목적이나 추가 맥락을 입력합니다',
  },
  {
    title: '보고서 확인',
    description:
      '장부와 검토 항목이 정리되면 보고서에서 최종 결과와 계산 근거를 확인합니다',
  },
]

export function LedgerGuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <AppDialog
      description="데이터를 연결한 뒤 장부가 만들어지는 순서를 확인하세요"
      footer={
        <button data-variant="primary" type="button" onClick={onClose}>
          가이드 확인 완료
        </button>
      }
      onClose={onClose}
      size="wide"
      title="장부 만들기 가이드"
    >
      <ol className="app-dialog-guide">
        {guideSteps.map((step, index) => (
          <li key={step.title}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
    </AppDialog>
  )
}
