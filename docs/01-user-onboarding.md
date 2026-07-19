# 사용자 온보딩 및 데이터 소스 연결

> 상태: Draft
>
> 대상: GIWA MVP Web
>
> 관련 기술 명세: [웹 앱 기술 명세](00-web-app-technical-spec.md)

## 1. 목적

이 문서는 사용자가 대장 웹 앱에 진입한 뒤 로그인 또는 회원가입을 완료하고, 첫 데이터 소스를 등록해 거래 내역 수집을 시작하기까지의 화면 흐름과 고려사항을 정의한다.

온보딩 완료는 모든 거래 분석이 끝난 시점이 아니다. 유효한 데이터 소스가 등록되고 서버가 비동기 수집 Job을 생성해 `job_id`를 반환한 시점을 완료로 본다. 수집·정규화·계산 상태는 홈에서 계속 확인한다.

## 2. 개념 흐름

```mermaid
flowchart TD
  start([app or web 진입]) --> loggedIn{로그인 상태인가?}

  loggedIn -->|예| linked{연결할 지갑이 있는가?}
  loggedIn -->|아니오| hasAccount{기존 계정이 있는가?}

  hasAccount -->|예| login[로그인]
  hasAccount -->|아니오| signup[회원가입]

  login --> linked
  signup --> linked

  linked -->|예| home[대장 홈 대시보드 화면]
  linked -->|아니오| selectType[연동할 지갑 선택]

  selectType --> accountType{지갑 유형은?}

  accountType -->|거래소| cexInput[거래소 선택<br/>API Key·Secret 입력]
  accountType -->|개인 지갑| walletInput[지갑 주소 입력 또는 연결]

  cexInput --> verify{연동 검증 성공?}
  walletInput --> verify

  verify -->|예| complete[지갑 연동 완료<br/>거래 내역 수집 시작]
  verify -->|아니오| error[오류 안내·정보 재입력]

  error --> selectType
  complete --> home
```

이 Mermaid는 목표 사용자 흐름을 표현한다. MVP에서는 거래소 API Key·Secret 대신 Upbit CSV를 받고, 브라우저 지갑 연결 대신 EVM 공개 주소를 직접 입력한다.

## 3. 용어

- **서비스 계정**: 사용자가 대장에 로그인하기 위한 identity와 session
- **데이터 소스**: Upbit CSV, EVM 지갑 주소처럼 거래 기록을 가져오는 출처
- **데이터 소스 등록**: 입력 형식과 접근 가능 여부를 확인해 소스를 저장한 상태
- **수집 Job**: 등록된 소스의 원본을 비동기로 가져오고 처리하는 작업
- **수집 완료**: Job이 원본 수집과 초기 처리를 마친 상태

화면 문구에서는 로그인 계정과 연동 대상을 모두 “계정”이라고 부르지 않는다. 연동 대상에는 “데이터 소스”, “거래소 내역”, “지갑 주소”처럼 구체적인 용어를 사용한다.

## 4. MVP 적용 범위

| 개념 흐름 | MVP 구현 | 후속 범위 |
| --- | --- | --- |
| 거래소 연결 | Upbit CSV 파일 업로드 | 거래소 API Key·Secret 연결 |
| 개인 지갑 | EVM 주소 1개 직접 입력 | 브라우저 지갑 연결과 서명 |
| 연동 검증 | 파일·주소 검증과 데이터 소스 등록 | 실시간 계정 권한 검사 |
| 거래 수집 | 등록 주소 기반 on-demand 수집 | 상시 자동 동기화 |
| 진행 상태 | Web API polling | 실시간 streaming 알림 |
| 완료 후 이동 | 홈에서 Job 진행 상태 표시 | 고급 알림·백그라운드 동기화 설정 |

거래소 API Key·Secret 입력 UI는 MVP에 노출하지 않는다. 후속 도입 시에는 조회 전용 권한만 허용하고 거래·출금 권한이 있는 Key는 거부해야 한다.

## 5. 화면 흐름과 상태

### 5.1 앱 진입과 세션 확인

앱 진입 직후 브라우저에 값이 있다는 이유만으로 로그인 상태를 판단하지 않는다. Web API가 Session과 최신 workspace membership을 확인한 뒤 이동 경로를 결정한다.

| 상태 | 화면 동작 |
| --- | --- |
| `CHECKING_SESSION` | 전용 loading 상태를 표시하고 로그인·홈을 미리 노출하지 않음 |
| `AUTHENTICATED` | 데이터 소스 존재 여부 확인 |
| `ANONYMOUS` | 로그인 또는 회원가입 진입 |
| `SESSION_EXPIRED` | 로그인 화면으로 이동하고 복구 가능한 이동 목적 보존 |
| `UNAVAILABLE` | 네트워크·서버 오류 안내와 재시도 제공 |

### 5.2 로그인과 회원가입

로그인 방식은 email, OIDC, 지갑 서명 중 아직 결정되지 않았다. 로그인용 지갑과 거래 수집용 지갑은 서로 다른 개념이다.

공통 UI 상태:

- 입력 대기
- 제출 중
- 필드 오류
- 인증 실패
- Rate Limit
- 성공

로그인 이후 서버가 확인한 기본 workspace를 기준으로 데이터 소스 존재 여부를 조회한다. 브라우저가 전달한 `workspace_id`, role 또는 permission은 신뢰하지 않는다.

### 5.3 데이터 소스 상태 확인

데이터 소스 존재 여부를 단순 boolean 하나로만 표현하지 않는다.

- 없음
- 등록됨
- 수집 대기
- 수집 중
- 사용자 검토 필요
- 수집 완료
- 수집 실패

등록된 소스가 있으면 Job이 진행 중이거나 일부 실패한 상태여도 홈으로 이동한다. 진행 상황과 복구 동작은 홈에서 제공한다.

### 5.4 데이터 소스 선택

MVP 선택지:

1. Upbit 거래 내역 CSV 업로드
2. EVM 지갑 주소 입력

권장 정책은 첫 소스 하나를 정상 등록하면 홈 진입을 허용하고, 홈의 “데이터 소스 추가”에서 두 번째 소스를 연결하는 방식이다. 두 소스를 모두 필수로 할지는 제품 결정이 필요하다.

## 6. 화면별 필드와 검증

| 화면 | 필드 | Client 검증 | Server 검증 |
| --- | --- | --- | --- |
| 로그인·회원가입 | 인증 방식 결정 후 정의 | 형식과 필수값 | identity, rate limit, session 생성 |
| 데이터 소스 선택 | `Upbit CSV` 또는 `EVM 지갑` | 하나 선택 | 지원 source type |
| Upbit CSV | 파일 1개 | 확장자, 크기 사전 안내 | MIME, 크기, checksum, encoding, header, column, 행 형식 |
| EVM 지갑 | 체인, 공개 주소, 선택 별칭 | 필수값과 기본 주소 형식 | 지원 체인, 주소 형식, workspace 중복, 개수 제한 |

브라우저 검증은 빠른 피드백을 위한 보조 수단이며 서버 검증을 최종 기준으로 한다.

### 6.1 Upbit CSV 업로드

처리 순서:

1. React가 Web API에 Upload Session을 요청한다.
2. 제한된 object key와 만료 시간을 가진 Presigned URL을 받는다.
3. React가 private Object Storage에 파일을 직접 업로드한다.
4. 업로드 완료를 Web API에 확인 요청한다.
5. 서버가 크기, MIME type, checksum과 파일 구조를 검증한다.
6. 성공한 경우에만 데이터 소스와 수집 Job을 생성한다.
7. React는 `job_id`를 기준으로 홈에서 진행 상태를 조회한다.

검증 고려사항:

- 허용 파일 크기와 최대 행 수
- 실제 MIME type과 확장자
- 지원 encoding
- 필수 header와 column
- 날짜, 수량, 금액 형식
- 비어 있거나 손상된 파일
- 동일 checksum 파일의 중복 등록

원본은 같은 object key로 덮어쓰지 않는다. 파일명과 CSV 내용은 분석 이벤트나 일반 application log에 기록하지 않는다.

### 6.2 EVM 지갑 주소

필드:

- 체인
- 지갑 공개 주소
- 사용자용 별칭(선택)

검증 고려사항:

- 지원 체인인지 확인
- EVM 주소 형식과 빈 값
- 같은 workspace 안의 중복 주소
- MVP 주소 개수 제한
- 등록 mutation의 idempotency

지갑 private key와 seed phrase는 어떤 경우에도 요청하지 않는다. 공개 주소 등록만으로 가능한 작업에 불필요한 서명이나 지갑 연결을 요구하지 않는다.

### 6.3 등록 완료

완료 화면은 다음을 분명히 전달한다.

- 데이터 소스 등록이 완료됨
- 거래 내역 수집은 background에서 시작됨
- 화면을 닫거나 새로고침해도 서버 작업은 계속됨
- 진행 상태는 홈에서 확인할 수 있음

“분석 완료”, “세금 계산 완료”, “모든 거래 검증 완료”처럼 오해할 수 있는 문구는 사용하지 않는다.

## 7. API와 비동기 Job

관련 공개 API:

| 목적 | API |
| --- | --- |
| 현재 사용자·workspace 확인 | `GET /api/v1/me` |
| 지갑 등록 | `POST /api/v1/sources/wallets` |
| 업로드 세션 생성 | `POST /api/v1/uploads` |
| 업로드 확정 | `POST /api/v1/uploads/{id}/confirm` |
| 수집 시작 | `POST /api/v1/syncs` |
| Job 진행 조회 | `GET /api/v1/jobs/{id}` |

수집 요청은 즉시 `job_id`를 반환한다. MVP 웹은 Job endpoint를 polling한다.

| 서버 상태 | 사용자 표시 | Polling |
| --- | --- | --- |
| `QUEUED` | 수집 준비 중 | 유지 |
| `RUNNING` | 거래 내역을 불러오는 중 | 유지 |
| `WAITING_REVIEW` | 확인이 필요한 항목이 있음 | 완화 또는 중지 |
| `SUCCEEDED` | 수집 완료 | 중지 |
| `FAILED` | 수집하지 못함 | 중지 |
| `CANCELLED` | 작업이 취소됨 | 중지 |

`WAITING_REVIEW`는 데이터 소스 연결 실패가 아니다. 사용자를 입력 화면으로 되돌리지 않고 홈 또는 Review 화면으로 안내한다.

## 8. 오류와 복구

| 유형 | 예시 | 사용자 동작 |
| --- | --- | --- |
| 입력 오류 | 잘못된 주소, 지원하지 않는 CSV | 해당 입력 화면에서 수정 |
| 중복 | 이미 등록된 주소·파일 | 기존 데이터 소스로 이동 |
| 일시적 외부 오류 | RPC Rate Limit, Source unavailable | 안내된 시간 이후 재시도 |
| 인증 오류 | Session 만료 | 재로그인 후 진행 상태 복구 |
| 처리 오류 | 정규화·대사 실패 | 홈에서 상태와 지원 경로 확인 |
| 검토 필요 | 주소 소유, 송금 목적 불명확 | Review 화면에서 사실관계 제출 |

Mermaid는 오류 후 데이터 소스 선택으로 돌아가지만 실제 UX는 사용자가 입력한 비민감 값을 유지하고 해당 입력 화면에서 바로 수정하게 한다. 후속 Secret 입력 기능에서는 Secret 값을 다시 표시하지 않는다.

오류에는 안전한 설명과 `request_id` 또는 `job_id`를 제공하되 다음 정보는 노출하지 않는다.

- 내부 stack trace와 private endpoint
- RPC 원문과 원본 CSV 내용
- Access·Refresh Token
- API Key·Secret
- 다른 workspace 리소스의 존재 여부

## 9. 보안 고려사항

- Access JWT는 JavaScript memory에만 저장한다.
- Refresh Token은 `HttpOnly; Secure; SameSite=Strict; Path=/` cookie에 저장한다.
- 두 Token을 `localStorage`와 `sessionStorage`에 저장하지 않는다.
- refresh와 logout endpoint는 Origin 검증과 CSRF 방어를 적용한다.
- Public Access JWT를 Go Engine으로 전달하지 않는다.
- Web Backend가 active Session, 최신 membership, resource ownership을 확인한다.
- Presigned URL은 짧은 만료 시간과 제한된 object key만 허용한다.
- 원본 Object Storage는 private, versioned, encrypted 상태로 유지한다.
- 지갑 주소도 사용자 데이터로 보고 로그와 분석 이벤트에서 원문을 피한다.

## 10. 접근성과 사용성

- 모든 입력에는 지속적으로 보이는 label을 둔다.
- 오류를 색상만으로 구분하지 않는다.
- 필드 오류를 해당 입력과 연결하고 화면 읽기 도구에 알린다.
- 키보드만으로 소스 선택과 파일 업로드를 완료할 수 있게 한다.
- 제출 중 중복 실행을 막고 진행 중임을 명확히 표시한다.
- 이전 단계로 이동해도 비민감 입력은 유지한다.
- 모바일 너비에서 CTA와 오류 메시지가 잘리지 않게 한다.
- 예상 처리 시간과 background 처리 여부를 설명한다.

## 11. 관측성과 제품 지표

온보딩 funnel 후보:

- 온보딩 시작
- 로그인 또는 회원가입 완료
- 데이터 소스 유형 선택
- 데이터 소스 등록 성공·실패
- 수집 Job 생성
- 첫 수집 성공·실패
- 추가 데이터 소스 등록

분석 이벤트에 지갑 주소, 파일명, CSV 내용, API Key, Secret, 오류 원문을 포함하지 않는다. 운영 추적에는 `request_id`, `trace_id`, `job_id`를 사용한다.

## 12. 완료 기준

- [ ] 세션 확인 중 로그인 또는 홈이 잘못 표시되지 않는다.
- [ ] 인증되지 않은 사용자가 보호 경로에 접근하면 인증 화면으로 이동한다.
- [ ] 기존 데이터 소스가 있는 사용자는 홈으로 이동한다.
- [ ] 데이터 소스가 없는 사용자는 연결 흐름으로 이동한다.
- [ ] Upbit CSV 1개와 EVM 주소 1개를 각각 등록할 수 있다.
- [ ] 주소·파일 검증 실패 시 수정 가능한 오류를 보여 준다.
- [ ] 수집 요청은 즉시 `job_id`를 반환한다.
- [ ] 새로고침 후에도 진행 중인 Job을 복구한다.
- [ ] 중복 제출이 데이터 소스나 Job을 중복 생성하지 않는다.
- [ ] Token과 자격증명이 browser storage, bundle, log, 분석 이벤트에 남지 않는다.
- [ ] 다른 workspace의 데이터 소스와 Job에 접근할 수 없다.

## 13. 미결정 사항

- 첫 소스 하나만 등록해도 온보딩 완료로 볼지 여부
- Upbit CSV와 EVM 주소를 모두 필수로 할지 여부
- MVP 로그인·회원가입 방식
- 첫 지원 EVM 체인
- 사용자당 주소·파일 개수 제한
- 업로드 크기, encoding, header와 최대 행 수
- 실패 Job의 사용자 직접 재시도 정책
- 데이터 소스 삭제와 원본 보관 기간
- 거래소 API Key 연결 도입 시점과 지원 권한

## 14. 기준 자료

- [대장 Flow](https://www.figma.com/board/9rt2FVwNe1Dfv9DXLThXok/%EB%8C%80%EC%9E%A5-flow?node-id=58-145)
- [Technical Spec — GIWA MVP v0.1](https://linear.app/giwa-daejang/document/technical-spec-giwa-mvp-v01-18d511232c66)
