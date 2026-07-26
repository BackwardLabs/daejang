export const productPageCopy = {
  sources: {
    eyebrow: 'DATA SOURCES',
    title: '데이터 소스',
    description: '거래소 파일과 온체인 지갑 연결 상태를 관리합니다.',
  },
  settings: {
    eyebrow: 'SETTINGS',
    title: '설정',
    description: '장부 생성 기간과 표시 환경을 관리합니다.',
  },
} as const

export const productSourceMocks = [
  {
    name: 'Upbit',
    detail: 'PDF · 2027-07-20 동기화',
    status: '연결됨',
    interactive: false,
  },
  {
    name: 'Ethereum 지갑',
    detail: '0x8f…3a2b',
    status: '연결됨',
    interactive: false,
  },
  {
    name: 'Base 지갑',
    detail: '0x41…91ce',
    status: '미연결',
    interactive: true,
  },
] as const
