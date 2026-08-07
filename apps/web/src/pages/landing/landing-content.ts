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
    title: '처리 근거 기록',
    description: '수집 범위와 정리 과정의 근거 기록',
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
    description: '지원되는 거래소 문서 또는 개인지갑 주소 등록',
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
