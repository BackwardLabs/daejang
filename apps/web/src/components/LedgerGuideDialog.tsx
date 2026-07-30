import { AppDialog } from './AppDialog.tsx'

const guideSteps = [
  {
    title: '거래소·지갑 연결',
    description:
      '거래 내역 파일을 등록하거나 읽기 전용 지갑을 연결합니다',
  },
  {
    title: '거래 수집 확인',
    description:
      '조회 연도와 수집 상태를 확인하고, 실패하면 안내에 따라 다시 시도합니다',
  },
  {
    title: '장부 검토',
    description:
      '수집된 거래를 확인하고 필요한 항목에 거래 목적과 맥락을 남깁니다',
  },
  {
    title: '보고서 확인',
    description:
      '검토를 마치면 보고서에서 결과와 계산 근거를 확인합니다',
  },
]

export function LedgerGuideDialog({ onClose }: { onClose: () => void }) {
  return (
    <AppDialog
      description="장부가 만들어지는 네 단계를 확인하세요"
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
