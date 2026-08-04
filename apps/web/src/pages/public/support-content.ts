export const supportFaqs = [
  {
    id: 'existing-account',
    question: '기존 계정이 있다고 표시되는 이유는 무엇인가요?',
    answer:
      '같은 본인확인 정보나 이미 등록된 로그인 수단이 확인되면 새 계정을 만들지 않습니다. 보안을 위해 화면에는 기존 계정의 상세 정보를 표시하지 않습니다.',
  },
  {
    id: 'identity-verification',
    question: '본인확인이 계속 실패해요',
    answer:
      '이름과 휴대전화 명의를 확인한 뒤 다시 시도해 주세요. 문제가 계속되면 오류가 발생한 시각과 화면을 고객지원에 알려 주세요. 주민등록번호나 신분증 사본은 이메일로 보내면 안 됩니다.',
  },
  {
    id: 'social-login-linking',
    question: '다른 소셜 로그인을 같은 계정에 추가할 수 있나요?',
    answer:
      '같은 Daejang 계정에 지원하는 로그인 수단을 추가할 수 있도록 설계합니다. 연결할 때는 기존 계정과 새 소셜 계정을 각각 다시 인증하며 이메일이나 이름이 같아도 자동으로 합치지 않습니다.',
  },
  {
    id: 'duplicate-wallet',
    question: '이미 등록된 지갑이라고 표시돼요',
    answer:
      '동일한 지갑 주소를 여러 계정에 중복 등록하지 않도록 제한할 수 있습니다. 문제가 계속되면 공개 지갑 주소와 오류 시각을 알려 주세요. 개인키나 시드 문구는 보내면 안 됩니다.',
  },
  {
    id: 'uploaded-documents',
    question: '업로드한 문서는 어떻게 처리되나요?',
    answer:
      '지원하는 거래자료를 정리하기 위해 문서 원본과 파싱 결과를 처리합니다. 처리 항목, 보유기간과 삭제 방법은 개인정보 처리방침에서 확인할 수 있습니다.',
  },
] as const

export const supportKakaoUrl = 'https://pf.kakao.com/_LxkNfX'
export const supportEmail = 'backwardlabs@gmail.com'
