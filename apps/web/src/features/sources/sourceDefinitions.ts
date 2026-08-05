import bulletEvm from '../../assets/sources/bullet-evm.svg'
import bulletUpbit from '../../assets/sources/bullet-upbit.svg'
import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'

export type SourceMethodId = 'evm-wallet' | 'upbit-pdf'
export type SourceMethodTone = 'evm' | 'upbit'

export type SourceMethodDefinition = {
  badge: string
  bullets: string[]
  description: string
  href: `/${string}`
  id: SourceMethodId
  intro: {
    description: string
    eyebrow: string
    noticeBody: string
    noticeTitle: string
    standardsLabel: string
    steps: Array<{
      description: string
      label: string
    }>
    subtitle: string
    title: string
  }
  logo: string
  noticeBody: string
  noticeTitle: string
  title: string
  tone: SourceMethodTone
}

export const sourceMethodDefinitions: Record<
  SourceMethodId,
  SourceMethodDefinition
> = {
  'upbit-pdf': {
    badge: '거래소 문서',
    bullets: [
      'Upbit 거래내역서 PDF만 필수',
      '암호화되지 않은 PDF 지원',
      '새 거래는 최신 PDF를 다시 등록',
    ],
    description:
      '거래소에서 내려받은 거래내역서 PDF를 등록해 거래를 불러옵니다.',
    href: '/sources/new/upbit',
    id: 'upbit-pdf',
    intro: {
      description:
        '지원되는 Upbit 거래내역서 PDF만 등록합니다. 입출금 증명서나 별도 자산 자료는 필수가 아닙니다.',
      eyebrow: 'DATA SOURCES · UPBIT',
      noticeBody:
        'Upbit PDF는 자동 동기화되지 않습니다. 이후 거래가 생기면 최신 거래내역서를 다시 업로드하세요.',
      noticeTitle: '새 거래는 새 PDF로 갱신합니다',
      standardsLabel: '등록 기준',
      steps: [
        {
          description: '거래내역서 파일을 선택합니다.',
          label: 'PDF 선택',
        },
        {
          description: '파일 정보와 등록 조건을 확인합니다.',
          label: '등록 정보 확인',
        },
        {
          description: '서버 확인 후 데이터 소스를 저장합니다.',
          label: '등록 완료',
        },
      ],
      subtitle: '거래소 거래내역서 PDF를 데이터 소스로 등록합니다.',
      title: 'PDF 한 파일로 거래 등록을 시작하세요',
    },
    logo: upbitLogo,
    noticeBody:
      '새 거래가 생기면 최신 거래내역서 PDF를 다시 등록해야 합니다.',
    noticeTitle: '자동 갱신되지 않아요',
    title: 'Upbit 거래내역서',
    tone: 'upbit',
  },
  'evm-wallet': {
    badge: '읽기 전용',
    bullets: [
      '공개 온체인 거래만 수집',
      '사용자가 지정한 선택 범위를 한 건의 작업으로 수집',
      '수집 요청 후 대기·처리·완료 상태 확인',
    ],
    description:
      '브라우저 지갑을 연결해 공개 온체인 거래를 읽기 전용으로 동기화합니다.',
    href: '/sources/new/wallet',
    id: 'evm-wallet',
    intro: {
      description:
        '지갑 소유권을 확인한 뒤 과세연도 또는 직접 조회 기간을 선택합니다.',
      eyebrow: 'DATA SOURCES · EVM',
      noticeBody:
        'private key·seed phrase·쓰기·출금 권한을 요구하거나 저장하지 않습니다. 소유권 확인은 가스비가 없는 오프체인 메시지 서명으로만 진행합니다.',
      noticeTitle: '자산 이동 권한은 수집하지 않습니다',
      standardsLabel: '연결 기준',
      steps: [
        {
          description: '브라우저 지갑을 선택하고 소유권 메시지에 서명합니다.',
          label: '지갑 연결',
        },
        {
          description: '체인·과세연도·동기화 범위를 확인합니다.',
          label: '수집 범위 확인',
        },
        {
          description: '최초 수집을 예약하고 연결 상태를 확인합니다.',
          label: '연결 완료',
        },
      ],
      subtitle: '공개 온체인 거래를 읽기 전용으로 동기화합니다.',
      title: '지갑 주소만 연결해 온체인 거래를 수집하세요',
    },
    logo: ethereumDiamond,
    noticeBody:
      'private key·seed phrase·쓰기·출금 권한은 수집하지 않습니다. 소유권 확인 서명은 거래나 자산 이동을 승인하지 않습니다.',
    noticeTitle: '자산 이동 권한을 요구하지 않아요',
    title: 'EVM Wallet',
    tone: 'evm',
  },
}

export const sourceMethodBullets: Record<SourceMethodTone, string> = {
  evm: bulletEvm,
  upbit: bulletUpbit,
}
