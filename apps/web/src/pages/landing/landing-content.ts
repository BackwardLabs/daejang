export const sourceJourney = [
  { label: '거래소', tone: 'source' },
  { label: '개인지갑', tone: 'source' },
  { label: '원본 기록', tone: 'neutral' },
  { label: '정리 완료', tone: 'result' },
  { label: '검토 필요', tone: 'result' },
  { label: '보고서', tone: 'result' },
] as const

export const principles = [
  {
    number: '01',
    title: '원본 기록 보존',
    description: '가져온 원본과 수집 근거 보관',
  },
  {
    number: '02',
    title: '검토 가능한 결과',
    description: '확인 이유와 현재 처리 상태 표시',
  },
  {
    number: '03',
    title: '재현 가능한 보고서',
    description: '입력부터 보고서까지 계산 근거 기록',
  },
] as const

export const workflowSteps = [
  {
    number: '01',
    title: '데이터 소스 연결',
    description: '거래소 거래내역 문서 또는 개인지갑 주소 등록',
  },
  {
    number: '02',
    title: '수집 범위 확인',
    description: '과세연도와 기록 수집 기간 확인',
  },
  {
    number: '03',
    title: '자동 처리',
    description: '서로 다른 기록 형식을 맞추고 관련 항목 연결',
  },
  {
    number: '04',
    title: '검토와 보고서',
    description: '남은 항목을 검토한 뒤 보고서 생성',
  },
] as const

export const faqs = [
  {
    id: 'data-sources',
    question: '어떤 데이터를 연결할 수 있나요?',
    answer:
      '거래소에서 발급한 거래내역서와 EVM 호환 개인지갑의 공개 주소를 연결할 수 있습니다. 거래·입출금, 전송·스왑 등 원본 기록을 수집합니다.',
  },
  {
    id: 'credentials',
    question: 'API 키나 개인키가 필요한가요?',
    answer:
      '현재 거래소는 문서 업로드, 개인지갑은 공개 주소 입력 방식입니다. API Key·Secret, 개인키, 시드 문구는 요청하거나 저장하지 않습니다.',
  },
  {
    id: 'background-processing',
    question: '수집 중에도 다른 화면을 사용할 수 있나요?',
    answer:
      '네. 등록 후 수집과 정규화는 백그라운드에서 진행됩니다. 다른 화면을 이용하면서 데이터 처리 현황에서 진행률과 오류를 확인할 수 있습니다.',
  },
  {
    id: 'review-required',
    question: '‘검토 필요’는 처리 실패를 의미하나요?',
    answer:
      '아닙니다. 자동 계산만으로 확정하기 어려운 항목을 사용자가 확인해야 한다는 뜻입니다. 원본 기록과 검토 이유, 예상 영향을 함께 표시합니다.',
  },
  {
    id: 'report-revision',
    question: '보고서는 어떻게 다시 만들 수 있나요?',
    answer:
      '검토 결과나 분류 기준을 수정하면 새 revision으로 다시 생성할 수 있습니다. 이전 revision과 원본 기록은 유지되어 변경 과정을 확인할 수 있습니다.',
  },
  {
    id: 'support',
    question: '지원 범위는 어떻게 되나요?',
    answer:
      '거래소 거래내역서 업로드와 EVM 호환 개인지갑의 공개 주소 연결을 지원합니다. 거래·입출금 및 온체인 전송·스왑 기록을 수집하며 조회 기간을 직접 설정할 수 있습니다.',
  },
] as const
