# 계정 인증 로컬 통합 검증

이 문서는 DB, Web API, 프런트를 한 로컬 환경에서 연결해 회원가입과 로그인을 검증하는 절차다. 운영 배포 절차는 `auth-deployment-runbook.md`를 따른다.

## worktree와 PR의 관계

`git worktree`는 같은 Git 저장소의 여러 브랜치를 서로 다른 로컬 디렉터리에서 동시에 여는 기능이다. worktree를 추가해도 GitHub 저장소, remote, PR이 새로 생기지 않는다.

현재 인증 작업의 관계는 다음과 같다.

| 로컬 디렉터리 | 브랜치 | 용도 |
| --- | --- | --- |
| `.worktrees/daejang-backend` | `wi11y-giwa-40-사용자-흐름-flow-backend` | Backend PR #17 |
| `.worktrees/daejang-frontend` | `wi11y-giwa-40-사용자-흐름-flow-frontend` | Frontend PR #18 |
| `.worktrees/daejang-auth-integration` | `local/giwa-40-auth-integration` | 두 PR을 합친 로컬 검증 전용 브랜치 |

`daejang-db`는 `daejang`과 다른 GitHub 저장소이므로 별도 clone이 필요하다. 반면 `daejang`의 세 worktree는 Git 객체와 remote를 공유한다.

로컬 통합 브랜치는 push하거나 네 번째 PR로 만들지 않는다. 기존 PR을 병합한 뒤 서버에서는 `main`만 pull한다. PR이 승인됐다는 이유로 저장소를 다시 clone하거나 같은 변경으로 새 PR을 만들지 않는다.

## 1. 두 PR을 합친 로컬 작업공간 준비

아래 명령은 `daejang` 원본 checkout에서 실행한다. 원본 checkout이나 기존 worktree에 미커밋 변경이 있으면 먼저 변경 소유자를 확인한다.

```bash
git fetch origin --prune

git worktree add \
  -b local/giwa-40-auth-integration \
  ../.worktrees/daejang-auth-integration \
  origin/main

git -C ../.worktrees/daejang-auth-integration \
  merge --no-ff --no-edit \
  wi11y-giwa-40-사용자-흐름-flow-backend

git -C ../.worktrees/daejang-auth-integration \
  merge --no-ff --no-edit \
  wi11y-giwa-40-사용자-흐름-flow-frontend
```

의존성을 설치한다.

```bash
cd ../.worktrees/daejang-auth-integration
npm ci
```

## 2. 로컬 PostgreSQL 시작

`daejang-db/.env.example`을 복사해 로컬 전용 `.env`를 만든다. `.env`가 이미 있으면 덮어쓰지 않는다.

```bash
cd /로컬/경로/daejang-db
test -f .env || cp .env.example .env
chmod 600 .env

docker compose config --quiet
make database-up
make database-status
make database-verify
docker compose ps
```

성공 기준은 다음과 같다.

- PostgreSQL이 `127.0.0.1:55432`에서 `healthy`
- migration `000015` 적용
- runtime role 검증 통과
- OAuth·이메일 저장 제약 검증 통과

호스트에서 실행하는 Web API는 Docker 서비스명 `postgres`가 아니라 loopback 주소를 사용한다.

```dotenv
DATABASE_URL=postgresql://daejang_web_app:<DAEJANG_WEB_APP_PASSWORD>@127.0.0.1:55432/daejang?sslmode=disable
```

## 3. 로컬 약관 fixture 등록

DB migration은 약관 테이블을 만들지만 약관 전문은 등록하지 않는다. 로컬 가입 E2E에는 `terms`, `privacy`, `identity_verification` 세 문서가 필요하다. 문서가 하나라도 없으면 API는 `503 LEGAL_DOCUMENTS_UNAVAILABLE`을 반환한다.

로컬 fixture는 운영 migration에 넣지 않는다. DB owner 권한으로 로컬 DB에만 등록하며, 본문에는 운영 약관이 아니라는 표시를 남긴다. 운영 환경에서는 법무 검토가 끝난 전문을 별도로 등록해야 한다.

다음 명령은 같은 버전의 fixture가 이미 있으면 중복 등록하지 않는다.

```bash
cd /로컬/경로/daejang-db

docker compose exec -T postgres sh -lc \
  'psql --no-psqlrc --set=ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB"' <<'SQL'
BEGIN;

CREATE TEMP TABLE local_legal_fixture (
  id UUID,
  document_type TEXT,
  content TEXT
) ON COMMIT DROP;

INSERT INTO local_legal_fixture (id, document_type, content)
VALUES
  (
    '00000000-0000-4000-8000-00000000e201',
    'terms',
    '로컬 E2E 전용 서비스 이용약관입니다. 운영에 사용하지 마십시오.'
  ),
  (
    '00000000-0000-4000-8000-00000000e202',
    'privacy',
    '로컬 E2E 전용 개인정보 처리 안내입니다. 운영에 사용하지 마십시오.'
  ),
  (
    '00000000-0000-4000-8000-00000000e203',
    'identity_verification',
    '로컬 E2E 전용 본인확인 정보 처리 안내입니다. 운영에 사용하지 마십시오.'
  ),
  (
    '00000000-0000-4000-8000-00000000e204',
    'marketing',
    '로컬 E2E 전용 선택적 마케팅 정보 수신 안내입니다. 운영에 사용하지 마십시오.'
  );

INSERT INTO web_private.legal_documents (
  id,
  document_type,
  locale,
  version,
  content_hash,
  effective_at
)
SELECT
  id,
  document_type,
  'ko-KR',
  'local-e2e-2026-07-28',
  encode(sha256(convert_to(content, 'UTF8')), 'hex'),
  TIMESTAMPTZ '2026-07-28 00:00:00+09'
FROM local_legal_fixture
ON CONFLICT (document_type, locale, version) DO NOTHING;

INSERT INTO web_private.legal_document_contents (
  legal_document_id,
  content
)
SELECT
  document.id,
  fixture.content
FROM local_legal_fixture fixture
JOIN web_private.legal_documents document
  ON document.document_type = fixture.document_type
 AND document.locale = 'ko-KR'
 AND document.version = 'local-e2e-2026-07-28'
ON CONFLICT (legal_document_id) DO NOTHING;

COMMIT;
SQL
```

등록 후 다음 요청이 세 필수 문서를 포함한 JSON을 반환해야 한다.

```bash
curl -i \
  'http://127.0.0.1:3000/api/v1/legal-documents/current?locale=ko-KR'
```

## 4. Web API 환경변수

통합 worktree의 `apps/web-api/.env.example`을 기준으로 `apps/web-api/.env`를 만든다. `npm run dev:api`는 이 파일을 자동으로 읽는다.

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=http://localhost:5173

DATABASE_URL=postgresql://daejang_web_app:<로컬 DB 비밀번호>@127.0.0.1:55432/daejang?sslmode=disable
RATE_LIMIT_HMAC_SECRET=<32바이트 이상 로컬 전용 secret>

OAUTH_ENABLED_PROVIDERS=naver,google,kakao
OAUTH_STATE_HMAC_SECRET=<32바이트 이상 로컬 전용 secret>
OAUTH_TRANSACTION_ENCRYPTION_KEY=<base64로 인코딩한 정확히 32바이트 key>

NAVER_CLIENT_ID=<값>
NAVER_CLIENT_SECRET=<값>
GOOGLE_CLIENT_ID=<값>
GOOGLE_CLIENT_SECRET=<값>
KAKAO_CLIENT_ID=<REST API key>
KAKAO_CLIENT_SECRET=<값>

EMAIL_AUTH_ENABLED=true
RESEND_API_KEY=<값>
EMAIL_FROM=GIWA <no-reply@auth.backwardlabs.io>
EMAIL_VERIFICATION_HMAC_SECRET=<32바이트 이상 로컬 전용 secret>

SIGNUP_ENABLED=true
IDENTITY_VERIFICATION_MODE=disabled
```

OAuth Client Secret과 Resend API Key는 `VITE_*` 변수에 넣으면 안 된다. 실제 값은 Git, PR, 로그, 채팅에 붙이지 않는다.

로컬 secret 생성 예시는 다음과 같다. 각 용도에 서로 다른 값을 사용한다.

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

## 5. 프런트 환경변수

`apps/web/.env`에는 브라우저에 공개해도 되는 값만 둔다.

```dotenv
VITE_WEB_API_BASE_URL=/api/v1
VITE_API_PROXY_TARGET=http://127.0.0.1:3000
```

## 6. 실행

터미널 1에서 Web API를 실행한다.

```bash
cd /로컬/경로/daejang-auth-integration
npm run dev:api
```

터미널 2에서 프런트를 실행한다.

```bash
cd /로컬/경로/daejang-auth-integration
npm run dev --workspace @daejang/web -- \
  --host 127.0.0.1 \
  --port 5173 \
  --strictPort
```

브라우저는 반드시 다음 주소로 연다.

```text
http://localhost:5173
```

`127.0.0.1:5173`으로 열면 OAuth 거래 cookie의 host와 callback host가 달라질 수 있다.

## 7. OAuth callback

각 공급자 콘솔에는 다음 로컬 callback이 정확히 등록돼 있어야 한다. 끝에 `/`를 추가하지 않는다.

```text
http://localhost:5173/api/v1/auth/oauth/naver/callback
http://localhost:5173/api/v1/auth/oauth/google/callback
http://localhost:5173/api/v1/auth/oauth/kakao/callback
```

운영 callback만 등록된 상태에서는 로컬 OAuth callback을 완료할 수 없다.

## 8. smoke test

```bash
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz
curl -i http://localhost:5173/api/v1/me

for provider in naver google kakao; do
  curl -sS -D - -o /dev/null \
    "http://localhost:5173/api/v1/auth/oauth/${provider}/start?intent=signup"
done
```

성공 기준:

- `/healthz`: `200 {"status":"ok"}`
- `/readyz`: `200 {"status":"ready"}`
- 비로그인 `/api/v1/me`: HTML이 아닌 JSON `401`
- Naver: `nid.naver.com`으로 향하는 `302`
- Google: `accounts.google.com`으로 향하는 `302`
- Kakao: `kauth.kakao.com`으로 향하는 `302`
- OAuth 시작 응답에 `HttpOnly; SameSite=Lax` 거래 cookie 포함

## 9. 브라우저 E2E 완료 기준

각 소셜 공급자에서 다음을 한 번씩 확인한다.

1. 실제 공급자 로그인 화면으로 이동
2. 공급자 동의 후 GIWA callback 복귀
3. 가입 의도에서는 pending GIWA 계정 생성
4. 약관 전문 표시와 필수 동의
5. 필수 약관 동의 후 `/dashboard` 이동
6. 새로고침 후 Session 유지
7. 로그아웃
8. 같은 공급자로 다시 로그인
9. `/dashboard` 재진입

이메일 가입에서는 실제 인증번호 수신, 인증번호 만료·오입력, 비밀번호 규칙, 로그아웃 후 재로그인을 함께 확인한다.

## 10. PR 승인 후

로컬 통합 검증이 끝나도 `local/giwa-40-auth-integration`을 push하지 않는다.
`BackwardLabs/daejang-db#17`의 병합 commit에 Engine을 고정하고 CI를 다시
통과시킨 뒤 통합 PR `BackwardLabs/daejang#20`만 병합한다. App PR #17, #18,
#19는 #20에 포함된 superseded PR이므로 별도로 병합하지 않고 닫는다.

서버에서는 두 저장소의 `main`만 `pull --ff-only`로 갱신한다. 서버에서 같은 변경을 다시 commit하거나 push하지 않는다.

모든 관련 worktree가 clean이고 더 이상 프로세스가 실행 중이지 않을 때만 로컬 worktree를 제거할 수 있다.

```bash
git -C /로컬/경로/daejang worktree list
git -C /로컬/경로/각-worktree status --short

git -C /로컬/경로/daejang \
  worktree remove /로컬/경로/각-worktree
```

`git worktree remove --force`는 사용하지 않는다.
