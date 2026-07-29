# 계정 인증 로컬 통합 검증

이 문서는 현재 `daejang-db/main`과 `daejang/main` checkout을 로컬에서 연결해
회원가입과 로그인을 확인하는 절차다. 과거 인증 전용 worktree나 개별 PR 브랜치를
만들 필요는 없다. 운영 서버 절차는
[`auth-deployment-runbook.md`](auth-deployment-runbook.md)를 따른다.

로컬 인증 E2E에는 두 저장소가 필요하다.

| 저장소 | 역할 |
| --- | --- |
| `BackwardLabs/daejang-db` | PostgreSQL, migration `000001`~`000030`, runtime role |
| `BackwardLabs/daejang` | Web API와 React 프런트 |

## 1. 기준 checkout을 준비한다

각 저장소가 clean한 `main`인지 확인하고 fast-forward한다. 미커밋 변경이 있으면
덮어쓰지 말고 먼저 변경 소유자를 확인한다.

```bash
export GIWA_WORKSPACE=/로컬/경로/Giwa-workspace
export GIWA_DB_DIR="$GIWA_WORKSPACE/daejang-db"
export GIWA_APP_DIR="$GIWA_WORKSPACE/daejang"

git -C "$GIWA_DB_DIR" status --short --branch
git -C "$GIWA_APP_DIR" status --short --branch

git -C "$GIWA_DB_DIR" fetch origin
git -C "$GIWA_DB_DIR" checkout main
git -C "$GIWA_DB_DIR" pull --ff-only origin main

git -C "$GIWA_APP_DIR" fetch origin
git -C "$GIWA_APP_DIR" checkout main
git -C "$GIWA_APP_DIR" pull --ff-only origin main

cd "$GIWA_APP_DIR"
npm ci
```

## 2. 로컬 PostgreSQL을 시작한다

로컬 DB의 실제 환경 파일은 `daejang-db/.env`다. 파일이 없을 때만 로컬 예시를
복사한다. 운영 password를 로컬 파일에 넣지 않는다.

```bash
cd "$GIWA_DB_DIR"

test -f .env || cp .env.example .env
chmod 600 .env

docker compose config --quiet
make check
make database-up
make database-status
make database-verify
docker compose ps
```

성공 기준은 PostgreSQL이 `healthy`이고 migration `000001`부터 `000030`까지
적용되며 runtime role과 Web OAuth·email 검증이 통과하는 것이다. 기본 host port는
`55432`다.

호스트에서 실행하는 Web API는 Docker service name `postgres`가 아니라
`127.0.0.1:55432`로 접속한다.

```text
postgresql://daejang_web_app:<로컬 DB 비밀번호>@127.0.0.1:55432/daejang?sslmode=disable
```

## 3. 로컬 약관 fixture를 등록한다

Migration은 약관 테이블을 만들지만 약관 전문을 자동 등록하지 않는다. 가입 E2E에는
현재 `terms`, `privacy`, `identity_verification` 문서가 필요하고, 선택 동의 화면까지
확인하려면 `marketing`도 등록한다.

아래 fixture는 로컬 전용이다. 운영 DB에는 법무 검토가 끝난 전문을 별도 승인 절차로
등록해야 한다.

```bash
cd "$GIWA_DB_DIR"

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
  'local-e2e-2026-07-29',
  encode(sha256(convert_to(content, 'UTF8')), 'hex'),
  TIMESTAMPTZ '2026-07-29 00:00:00+09'
FROM local_legal_fixture
ON CONFLICT (document_type, locale, version) DO NOTHING;

INSERT INTO web_private.legal_document_contents (
  legal_document_id,
  content
)
SELECT
  document.id,
  fixture.content
FROM local_legal_fixture AS fixture
JOIN web_private.legal_documents AS document
  ON document.document_type = fixture.document_type
 AND document.locale = 'ko-KR'
 AND document.version = 'local-e2e-2026-07-29'
ON CONFLICT (legal_document_id) DO NOTHING;

COMMIT;
SQL
```

## 4. Web API 환경 파일을 만든다

Web API의 로컬 환경 파일은 `daejang/apps/web-api/.env`다. 예시를 복사한 뒤 실제
로컬 값으로 바꾼다.

```bash
cd "$GIWA_APP_DIR"

test -f apps/web-api/.env || \
  cp apps/web-api/.env.example apps/web-api/.env
chmod 600 apps/web-api/.env
```

최소한 다음 항목을 확인한다.

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=http://localhost:5173

DATABASE_URL=postgresql://daejang_web_app:<로컬 DB 비밀번호>@127.0.0.1:55432/daejang?sslmode=disable
SIGNUP_ENABLED=true
IDENTITY_VERIFICATION_MODE=disabled
UPBIT_PDF_IMPORT_ENABLED=false

OAUTH_ENABLED_PROVIDERS=naver,google,kakao
OAUTH_STATE_HMAC_SECRET=<32바이트 이상 로컬 전용 secret>
OAUTH_TRANSACTION_ENCRYPTION_KEY=<base64로 인코딩한 32바이트 key>

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
```

`SIGNUP_ENABLED=true`와 `IDENTITY_VERIFICATION_MODE=disabled`는 가입과 필수 약관
동의를 허용하지만 본인확인 완료 claim을 만들지 않는다.
`UPBIT_PDF_IMPORT_ENABLED=false`도 유지한다.

OAuth secret과 Resend API key는 `VITE_*` 변수에 넣지 않는다. 용도마다 서로 다른
로컬 secret을 만들 수 있다.

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -base64 32
```

## 5. 프런트 환경 파일을 만든다

프런트 환경 파일은 `daejang/apps/web/.env`다. 브라우저에 공개해도 되는 값만 둔다.

```bash
cd "$GIWA_APP_DIR"

test -f apps/web/.env || cp apps/web/.env.example apps/web/.env
chmod 600 apps/web/.env
```

```dotenv
VITE_WEB_API_BASE_URL=/api/v1
VITE_API_PROXY_TARGET=http://127.0.0.1:3000
```

## 6. Web API와 프런트를 실행한다

인증 E2E에는 Engine이 필요하지 않다. `UPBIT_PDF_IMPORT_ENABLED=false`를 유지하기
위해 Web API와 프런트를 각각 실행한다.

터미널 1:

```bash
cd "$GIWA_APP_DIR"
npm run dev:api
```

터미널 2:

```bash
cd "$GIWA_APP_DIR"
npm run dev --workspace @daejang/web -- \
  --host 127.0.0.1 \
  --port 5173 \
  --strictPort
```

브라우저는 다음 주소로 연다.

```text
http://localhost:5173
```

`127.0.0.1:5173`으로 열면 OAuth transaction cookie의 host와 callback host가
달라질 수 있다.

## 7. OAuth callback을 확인한다

각 provider 개발자 console에는 다음 로컬 callback이 정확히 등록돼 있어야 한다.
끝에 `/`를 추가하지 않는다.

```text
http://localhost:5173/api/v1/auth/oauth/naver/callback
http://localhost:5173/api/v1/auth/oauth/google/callback
http://localhost:5173/api/v1/auth/oauth/kakao/callback
```

운영 callback만 등록돼 있으면 provider 로그인 화면까지는 열려도 로컬 callback을
완료할 수 없다.

## 8. API smoke test를 실행한다

```bash
curl -i http://127.0.0.1:3000/healthz
curl -i http://127.0.0.1:3000/readyz
curl -i http://localhost:5173/api/v1/me
curl -i \
  'http://localhost:5173/api/v1/legal-documents/current'

for provider in naver google kakao; do
  curl -sS -D - \
    -H 'Origin: http://localhost:5173' \
    -H 'Content-Type: application/json' \
    --data '{"intent":"signup","returnTo":"/signup/terms"}' \
    "http://localhost:5173/api/v1/auth/oauth/${provider}/start"
done
```

성공 기준:

- `/healthz`: `200`과 `{"status":"ok"}`
- `/readyz`: `200`과 `{"status":"ready"}`
- 비로그인 `/api/v1/me`: HTML이 아닌 JSON `401`
- 약관 endpoint: 현재 로컬 fixture를 포함한 JSON
- Naver: `nid.naver.com`으로 향하는 `authorizationUrl` 반환
- Google: `accounts.google.com`으로 향하는 `authorizationUrl` 반환
- Kakao: `kauth.kakao.com`으로 향하는 `authorizationUrl` 반환
- OAuth 시작 응답: `HttpOnly; SameSite=Lax` transaction cookie 포함

## 9. 브라우저에서 사용자 흐름을 확인한다

각 OAuth provider에서 다음 흐름을 한 번씩 완료한다.

1. 가입 화면에서 provider 선택
2. 실제 provider 인증 화면으로 이동
3. provider 동의 후 GIWA callback 복귀
4. pending GIWA 계정 생성
5. 필수 약관 전문 확인과 동의
6. `/dashboard` 진입
7. 새로고침 후 session 유지
8. 로그아웃 후 이전 session으로 보호 API 접근 불가
9. 같은 provider로 다시 인증하고 기존 GIWA 계정으로 로그인

이메일에서는 다음 happy path와 edge case를 함께 확인한다.

- 새 이메일로 인증번호 수신, 비밀번호 설정, 필수 약관 동의, 가입 완료
- 잘못된 인증번호와 만료된 인증번호가 입력란 가까이에 표시됨
- 이미 가입한 이메일은 새 인증번호를 보내지 않고 기존 계정 안내
- 로그아웃 후 이메일과 비밀번호로 재로그인

마지막으로 DB에 verified subject name claim을 임의 생성하지 않았고 PDF 가져오기가
비활성인지 확인한다. 외부 NICE 연동이 없는 로컬 가입 성공을 본인확인 성공으로
해석하지 않는다.

## 10. 종료한다

Web API와 프런트 터미널에서 `Ctrl+C`를 누른다. PostgreSQL data를 유지하려면
container만 멈춘다.

```bash
cd "$GIWA_DB_DIR"
docker compose stop postgres
```

`docker compose down --volumes`는 로컬 DB data를 삭제하므로 데이터를 버리려는
의도가 명확할 때만 사용한다.
