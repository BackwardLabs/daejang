import { supportFaqs } from '../public/support-content.ts'

export const sourceJourney = [
  { label: '거래소', tone: 'source' },
  { label: '개인지갑', tone: 'source' },
  { label: '처리 근거', tone: 'neutral' },
  { label: '정리 완료', tone: 'result' },
  { label: '검토 필요', tone: 'result' },
  { label: '보고서', tone: 'result' },
] as const

export const principles = [
  {
    number: '01',
    title: '수집 출처와 기간 확인',
    description: '업비트 거래내역서와 개인지갑에서 가져온 기록의 출처와 수집 기간을 확인합니다.',
  },
  {
    number: '02',
    title: '검토할 거래와 이유 표시',
    description: '금액이나 분류가 확정되지 않은 거래를 구분하고, 확인이 필요한 이유를 함께 보여줍니다.',
  },
  {
    number: '03',
    title: '계산 근거가 남는 세금 보고서',
    description: '검토 결과와 세금 계산 근거를 반영해 다시 확인할 수 있는 보고서를 만듭니다.',
  },
] as const

export const workflowSteps = [
  {
    number: '01',
    title: '거래 기록 연결',
    description: '업비트 거래내역서 PDF를 올리거나 개인지갑 주소를 등록합니다.',
  },
  {
    number: '02',
    title: '대상 기간 설정',
    description: '보고할 과세연도와 거래 기록을 수집할 기간을 선택합니다.',
  },
  {
    number: '03',
    title: '거래내역 자동 정리',
    description: '거래소와 지갑 기록을 같은 형식으로 정리하고 서로 관련된 내역을 연결합니다.',
  },
  {
    number: '04',
    title: '확인 후 보고서 생성',
    description: '확인이 필요한 거래를 검토하고 반영된 결과로 세금 보고서를 만듭니다.',
  },
] as const

export const collectionSupport = {
  timezone: '대한민국 표준시(KST, UTC+9) 기준',
  documentTypes: ['Upbit 거래 내역서'],
  networks: [
    {
      id: 'ethereum-mainnet',
      name: 'Ethereum mainnet',
      collectedRanges: [
        {
          start: '2015-07-31 00:26:28',
          end: '2022-09-15 15:42:42',
        },
        {
          start: '2026-07-18 19:56:23',
          end: '2026-08-07 16:14:59',
        },
      ],
      missingRanges: [
        {
          start: '2022-09-15 15:42:59',
          end: '2026-07-18 19:56:11',
        },
      ],
    },
    {
      id: 'optimism-mainnet',
      name: 'Optimism mainnet',
      collectedRanges: [
        {
          start: '2021-11-12 06:16:39',
          end: '2025-10-09 16:05:09',
        },
        {
          start: '2026-07-20 15:33:19',
          end: '2026-08-07 18:38:15',
        },
      ],
      missingRanges: [
        {
          start: '2025-10-09 16:05:11',
          end: '2026-07-20 15:33:17',
        },
      ],
    },
    {
      id: 'giwa-sepolia',
      name: 'GIWA Sepolia',
      collectedRanges: [
        {
          start: '2025-07-24 17:18:36',
          end: '2026-08-05 03:01:00',
        },
      ],
      missingRanges: [],
    },
  ],
} as const

export const faqs = supportFaqs
