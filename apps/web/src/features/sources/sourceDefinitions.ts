import bulletEvm from '../../assets/sources/bullet-evm.svg'
import bulletUpbit from '../../assets/sources/bullet-upbit.svg'
import ethereumDiamond from '../../assets/sources/ethereum-diamond.png'
import upbitLogo from '../../assets/sources/upbit-logo.png'

export type SourceMethodId = 'evm-address' | 'upbit-pdf'
export type SourceMethodTone = 'evm' | 'upbit'

export type SourceMethodDefinition = {
  badge: string
  bullets: string[]
  description: string
  href: string
  id: SourceMethodId
  intro: {
    badge: string
    description: string
    eyebrow: string
    footer: string
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
    badge: 'PDF 업로드',
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
      badge: 'PDF 업로드',
      description:
        'MVP에서는 암호화되지 않은 Upbit 거래내역서 PDF만 등록하면 됩니다. 입출금 증명서나 별도 자산 자료는 필수가 아닙니다.',
      eyebrow: 'DATA SOURCES · UPBIT',
      footer:
        '소스 등록이 끝나면 조회 기간과 문서 포함 기간을 확인한 뒤 수집을 시작합니다.',
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
  'evm-address': {
    badge: '공개 주소',
    bullets: [
      '공개 온체인 거래만 수집',
      '선택한 조회 기간을 요청 시 수집',
      '지갑 서명·쓰기·출금 권한 불필요',
    ],
    description:
      '공개 지갑 주소의 온체인 거래를 읽기 전용으로 수집합니다.',
    href: '/sources/new/wallet',
    id: 'evm-address',
    intro: {
      badge: '읽기 전용',
      description:
        '지원 체인과 공개 주소를 등록하고, 다음 단계에서 과세연도 또는 직접 조회 기간을 선택합니다.',
      eyebrow: 'DATA SOURCES · EVM',
      footer:
        '등록 이후 조회 기간과 예상 거래를 확인한 뒤 수집을 시작합니다.',
      noticeBody:
        'private key·seed phrase·쓰기·출금 권한과 소유권 확인 서명을 요구하거나 저장하지 않습니다.',
      noticeTitle: '자산 이동 권한은 수집하지 않습니다',
      standardsLabel: '등록 방식',
      steps: [
        {
          description: '지원 체인과 공개 주소를 입력합니다.',
          label: '공개 주소 등록',
        },
        {
          description: '과세연도 또는 직접 기간을 선택합니다.',
          label: '수집 범위 확인',
        },
        {
          description: '예상 건수와 누락 경고를 확인합니다.',
          label: '수집 전 확인',
        },
      ],
      subtitle: '공개 온체인 거래를 읽기 전용으로 수집합니다.',
      title: '공개 주소만 등록해 온체인 거래를 수집하세요',
    },
    logo: ethereumDiamond,
    noticeBody:
      'private key·seed phrase·쓰기·출금 권한은 수집하지 않습니다.',
    noticeTitle: '자산 이동 권한을 요구하지 않아요',
    title: 'EVM Wallet',
    tone: 'evm',
  },
}

export const sourceMethodBullets: Record<SourceMethodTone, string> = {
  evm: bulletEvm,
  upbit: bulletUpbit,
}
