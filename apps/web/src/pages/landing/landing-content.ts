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

export const faqs = supportFaqs
