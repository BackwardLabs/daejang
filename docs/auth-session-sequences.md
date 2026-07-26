# 인증·Session Sequence

이 문서는 회원가입 시작부터 필수 동의, 서비스 계정 인증, Session 확인, Engine 요청과 전체 Session 폐기까지의 경계를 단계별로 설명한다.

공통 원칙:

- `web_private.users.id` UUID가 유일한 사용자 식별자다.
- 브라우저가 보낸 `user_id`는 인증이나 데이터 소유권 판단에 사용하지 않는다.
- 별도 workspace, ledger account ID 또는 Engine user ID를 만들지 않는다.
- Engine의 `subject_id`에는 같은 사용자 UUID의 문자열 표현을 사용한다.
- 현재 Engine 연동은 mTLS readiness 확인까지만 구현되어 있다. 4번의 사용자 RPC와 소유권 비교는 Engine API를 연결할 때 적용한다.

## 1. 가입 시작과 필수 동의

```mermaid
sequenceDiagram
  autonumber

  actor U as 사용자
  participant W as React Web
  participant B as Fastify API
  participant P as PostgreSQL

  U->>W: 회원가입 시작
  W->>B: 가입 시작 요청

  B->>P: pending 사용자 생성
  P-->>B: canonical user_id UUID

  B->>P: 현재 필수 문서 조회
  P-->>B: 문서 ID·버전·시행일·내용 hash

  B-->>W: 사용자 UUID와 필수 문서
  W-->>U: 약관·개인정보 내용 표시

  U->>W: 문서별 동의
  W->>B: 문서 ID와 동의 결과 제출

  B->>P: 사용자별 동의 이력 추가
  Note right of P: 동의 이력은<br/>수정·삭제하지 않음

  P-->>B: 서버 기록 시각
  B-->>W: 필수 동의 완료
  W-->>U: 인증 방식 선택 화면
```

## 2. 서비스 계정 인증과 사용자 활성화

```mermaid
sequenceDiagram
  autonumber

  actor U as 사용자
  participant W as React Web
  participant B as Fastify API
  participant P as PostgreSQL

  U->>W: 인증 방식 선택
  W->>B: 인증 완료 요청

  B->>B: 공급자 증명 검증
  B->>P: provider subject 조회

  alt 다른 사용자에게 연결된 인증 계정
    P-->>B: identity 충돌
    B-->>W: 계정 연결 오류
    W-->>U: 다른 인증 방식 또는 로그인 안내
  else 연결 가능한 인증 계정
    B->>P: auth identity와 user_id 연결
    B->>P: 현재 필수 동의 확인

    alt 동의 누락 또는 문서 버전 변경
      P-->>B: 동의 불충족
      B-->>W: 최신 문서 재동의 필요
      W-->>U: 동의 화면으로 이동
    else 필수 동의 유효
      B->>P: 사용자 상태를 active로 변경
      B->>P: 새 Session 저장

      Note right of P: Session Token 원문 대신<br/>SHA-256 hash 저장

      P-->>B: Session과 session_epoch
      B-->>W: HttpOnly Session Cookie
      W-->>U: 가입 완료
    end
  end
```

## 3. 로그인 이후 Session 확인

```mermaid
sequenceDiagram
  autonumber

  actor U as 사용자
  participant W as React Web
  participant B as Fastify API
  participant P as PostgreSQL

  U->>W: 대시보드 접근
  W->>B: GET /api/v1/me

  Note right of W: 브라우저가 Session Cookie를<br/>자동으로 전송

  B->>P: Token hash로 Session 조회
  P->>P: 사용자 active 상태 확인
  P->>P: session_epoch 확인
  P->>P: 절대·유휴 만료 확인

  alt 유효한 Session
    P->>P: 최근 활동 시각과 유휴 만료 갱신
    P-->>B: user_id와 사용자 정보
    B-->>W: 인증된 사용자
    W-->>U: 대시보드 표시
  else 유효하지 않은 Session
    P->>P: 잘못된 Session 삭제
    P-->>B: Session 없음
    B-->>W: 401 및 Cookie 제거
    W-->>U: 로그인 화면으로 이동
  end
```

## 4. 데이터·장부·보고서 Engine 요청

현재 구현은 client certificate 기반 mTLS 연결 readiness 확인까지다. 실제 Engine 사용자 RPC를 추가할 때 다음 경계를 적용한다.

```mermaid
sequenceDiagram
  autonumber

  actor U as 사용자
  participant W as React Web
  participant B as Fastify API
  participant P as Web PostgreSQL
  participant E as Go Engine

  U->>W: 데이터 처리 요청
  W->>B: 보호된 API 요청

  B->>P: Session 검증
  P-->>B: canonical user_id UUID

  B->>B: RequestContext 생성
  Note right of B: user_id는 브라우저 입력이 아니라<br/>서버 Session에서만 가져옴

  B->>E: mTLS gRPC 요청
  Note right of E: RequestContext<br/>user_id + request_id

  E->>E: user_id UUID 형식 확인
  E->>E: 저장된 subject_id와 비교

  alt 현재 사용자 소유
    E->>E: 수집·계산·조회 실행
    E-->>B: 처리 결과
    B-->>W: 공개 JSON 응답
    W-->>U: 결과 표시
  else 다른 사용자 소유
    E-->>B: NOT_FOUND
    B-->>W: 404
    W-->>U: 리소스를 찾을 수 없음
  end
```

## 5. 전체 로그아웃·정지·삭제

```mermaid
sequenceDiagram
  autonumber

  actor U as 사용자
  participant W as React Web
  participant B as Fastify API
  participant P as PostgreSQL

  alt 전체 로그아웃
    U->>W: 전체 로그아웃 요청
    W->>B: Session 전체 폐기 요청
  else 계정 정지 또는 삭제
    B->>B: 계정 상태 변경 결정
  end

  B->>P: 사용자 row 잠금
  B->>P: session_epoch 증가
  B->>P: 사용자 Session 전체 삭제

  P-->>B: 폐기된 Session 수
  B-->>W: Session Cookie 제거
  W-->>U: 로그인 화면으로 이동

  Note over W,P: 기존 Token을 다시 보내도<br/>epoch 불일치로 인증되지 않음
```
