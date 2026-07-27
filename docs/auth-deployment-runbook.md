# 계정 인증 배포 실행 순서

이 문서는 OAuth·이메일 인증 변경을 DB부터 프론트까지 순서대로 배포하기 위한 실행 절차다. 과거 Linear 초안이 아니라 현재 코드와 다음 세 PR을 기준으로 한다.

- DB: [BackwardLabs/daejang-db#15](https://github.com/BackwardLabs/daejang-db/pull/15)
- Web API·Edge: [BackwardLabs/daejang#17](https://github.com/BackwardLabs/daejang/pull/17)
- Frontend: [BackwardLabs/daejang#18](https://github.com/BackwardLabs/daejang/pull/18)

## 1. 배포 구조

```mermaid
flowchart LR
  Browser["사용자 브라우저"] --> Worker["Cloudflare Worker<br/>daejang.backwardlabs.io"]
  Worker -->|"/api/*"| Access["Cloudflare Access"]
  Access --> Nginx["비공개 API origin<br/>NGINX :8443"]
  Nginx --> API["Web API :3000"]
  API --> DB[("PostgreSQL<br/>daejang_web_app")]
  API --> Resend["Resend"]
  API --> Naver["Naver OAuth"]
  API --> Google["Google OIDC"]
  API --> Kakao["Kakao OIDC"]
```

`postgresql://daejang_web_app:비밀번호@postgres:5432/daejang`의 `postgres`는 공개 호스트명이 아니다. `daejang-db` Compose가 만드는 `daejang-db_default` Docker network 안에서만 해석되는 서비스 이름이다. 따라서 Web API Compose도 같은 external network에 참가해야 한다.

## 2. 병합 전 사람 확인

다음 작업은 팀의 정식 리뷰어가 수행한다.

1. DB PR #15의 migration, runtime role 권한, CI 성공을 확인한다.
2. Backend PR #17의 OAuth state·nonce·PKCE, provider token 비저장, 이메일 rate limit을 확인한다.
3. Frontend PR #18의 실제 provider 이동, 가입 완료 후 `/dashboard` 이동, 약관 전문 표시를 확인한다.
4. `#15 → #17 → #18` 순서로 병합한다.

AI 검증은 위 사람 리뷰를 대신하지 않는다.

## 3. 서버 위치 확인

아래 명령은 **실제 운영 서버**에서 실행한다. 현재 `ssh giwa`로 확인한 호스트에는 저장소와 Docker가 없었으므로 그 호스트를 운영 서버라고 가정하지 않는다.

먼저 실제 배포 경로를 한 번 정한다.

```bash
export GIWA_DEPLOY_ROOT=/실제/운영/배포/경로
test -d "$GIWA_DEPLOY_ROOT" || {
  echo "GIWA_DEPLOY_ROOT를 실제 운영 경로로 설정해야 합니다"
  exit 1
}
```

운영 서버와 경로가 확정되기 전에는 다음 단계를 실행하지 않는다.

## 4. 서버에서 저장소 준비

두 저장소가 아직 없다면 운영 서버에서 각각 한 번만 clone한다.

```bash
cd "$GIWA_DEPLOY_ROOT"

test -d daejang-db/.git || \
  git clone git@github.com:BackwardLabs/daejang-db.git

test -d daejang/.git || \
  git clone git@github.com:BackwardLabs/daejang.git
```

이미 clone돼 있다면 삭제하거나 다시 clone하지 않고 `main`을 fast-forward로 갱신한다.

```bash
git -C "$GIWA_DEPLOY_ROOT/daejang-db" fetch origin
git -C "$GIWA_DEPLOY_ROOT/daejang-db" checkout main
git -C "$GIWA_DEPLOY_ROOT/daejang-db" pull --ff-only origin main

git -C "$GIWA_DEPLOY_ROOT/daejang" fetch origin
git -C "$GIWA_DEPLOY_ROOT/daejang" checkout main
git -C "$GIWA_DEPLOY_ROOT/daejang" pull --ff-only origin main
```

두 저장소에 미커밋 변경이 있으면 `pull`을 강행하지 말고 중단해 변경 소유자를 먼저 확인한다.

## 5. DB 환경변수 준비

운영 서버의 기존 `daejang-db/.env`는 비밀번호가 들어 있는 secret 파일이다. 이미 존재하면 덮어쓰지 않는다.

```bash
cd "$GIWA_DEPLOY_ROOT/daejang-db"
test -f .env || cp .env.example .env
chmod 600 .env
```

`.env`에는 적어도 다음 값이 필요하다.

```dotenv
POSTGRES_DB=daejang
POSTGRES_USER=daejang_owner
POSTGRES_PASSWORD=<owner 전용 무작위 비밀번호>

DAEJANG_WEB_APP_PASSWORD=<Web API 전용 무작위 비밀번호>
DAEJANG_JIT_APP_PASSWORD=<JIT 전용 무작위 비밀번호>
DAEJANG_SOURCE_APP_PASSWORD=<Source 전용 무작위 비밀번호>
DAEJANG_QUERY_APP_PASSWORD=<Query 전용 무작위 비밀번호>
DAEJANG_EVENT_APP_PASSWORD=<Event 전용 무작위 비밀번호>
DAEJANG_LOT_APP_PASSWORD=<Lot 전용 무작위 비밀번호>
```

`DAEJANG_WEB_APP_PASSWORD`는 다음 단계의 `WEB_DATABASE_URL` 안에 넣는 비밀번호와 정확히 같아야 한다. 실제 값은 Git, PR, Slack, 명령 출력에 붙여 넣지 않는다.

## 6. DB 시작과 migration 적용

```bash
cd "$GIWA_DEPLOY_ROOT/daejang-db"

docker compose config --quiet
make database-up
make database-status
make database-verify
docker compose ps
```

성공 기준은 다음과 같다.

- `postgres`가 `healthy`
- migration `000015`가 적용됨
- `verify-roles`와 `verify-web-oauth-email`이 성공함
- `daejang-db_default` network가 존재함

운영 데이터가 생긴 뒤에는 migration을 `down`하지 않는다. 문제가 있으면 새 migration으로 forward-fix한다.

## 7. Web API 운영 환경변수 준비

```bash
cd "$GIWA_DEPLOY_ROOT/daejang"
test -f deploy/production.env || \
  cp deploy/production.env.example deploy/production.env
chmod 600 deploy/production.env
```

`deploy/production.env`에서 다음 값을 실제 secret과 경로로 바꾼다.

```dotenv
PUBLIC_ORIGIN=https://daejang.backwardlabs.io
DAEJANG_DB_NETWORK=daejang-db_default
WEB_DATABASE_URL=postgres://daejang_web_app:<DB의 DAEJANG_WEB_APP_PASSWORD>@postgres:5432/daejang

OAUTH_STATE_HMAC_SECRET=<32바이트 이상 무작위 secret>
OAUTH_TRANSACTION_ENCRYPTION_KEY=<base64 인코딩한 32바이트 key>
RATE_LIMIT_HMAC_SECRET=<32바이트 이상 무작위 secret>
EMAIL_VERIFICATION_HMAC_SECRET=<32바이트 이상 무작위 secret>

NAVER_CLIENT_ID=<네이버 Client ID>
NAVER_CLIENT_SECRET=<네이버 Client Secret>
GOOGLE_CLIENT_ID=<Google Client ID>
GOOGLE_CLIENT_SECRET=<Google Client Secret>
KAKAO_CLIENT_ID=<카카오 REST API key>
KAKAO_CLIENT_SECRET=<카카오 Client Secret>

RESEND_API_KEY=<Resend API key>
EMAIL_FROM=GIWA <no-reply@인증된-발신-도메인>
```

독립 secret 생성 예시는 다음과 같다. 같은 값을 여러 용도에 재사용하지 않는다.

```bash
openssl rand -hex 32
openssl rand -base64 32
```

TLS와 Engine mTLS 인증서 경로도 실제 서버 파일로 지정해야 한다.

```dotenv
PUBLIC_TLS_CERT_PATH=/실제/경로/public-cert.pem
PUBLIC_TLS_KEY_PATH=/실제/경로/public-key.pem
ENGINE_SERVER_CERT_PATH=/실제/경로/engine-server-cert.pem
ENGINE_SERVER_KEY_PATH=/실제/경로/engine-server-key.pem
ENGINE_CLIENT_CA_PATH=/실제/경로/engine-client-ca.pem
ENGINE_CA_PATH=/실제/경로/engine-ca.pem
WEB_ENGINE_CLIENT_CERT_PATH=/실제/경로/web-engine-client-cert.pem
WEB_ENGINE_CLIENT_KEY_PATH=/실제/경로/web-engine-client-key.pem
ENGINE_PROBE_CERT_PATH=/실제/경로/probe-client-cert.pem
ENGINE_PROBE_KEY_PATH=/실제/경로/probe-client-key.pem
```

## 8. Web API·Engine 시작

Engine image가 private GitHub module을 받아야 하므로 build 시점에만 `GH_PAT`가 필요하다.

```bash
cd "$GIWA_DEPLOY_ROOT/daejang"

read -s -p "GH_PAT: " GH_PAT
echo
export GH_PAT

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  config --quiet

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  build

unset GH_PAT

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  up -d

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  ps
```

`web-api`, `engine`, `sync-worker`, `nginx`가 정상 상태여야 한다. PostgreSQL port와 Web API port는 공개하지 않고 NGINX만 API origin에 연결한다.

## 9. Cloudflare Worker 연결

먼저 NGINX 8443으로 연결되는 별도 비공개 API hostname과 Cloudflare Access service-token policy를 준비한다. 공개 사이트 주소 `https://daejang.backwardlabs.io`를 `WEB_API_ORIGIN`으로 다시 넣으면 Worker가 자기 자신을 호출하므로 사용할 수 없다.

로컬 작업 PC 또는 배포 CI에서 실행한다.

```bash
cd /로컬/또는/CI의/daejang
npm ci
npm run build

npx wrangler secret put WEB_API_ORIGIN
npx wrangler secret put CF_ACCESS_CLIENT_ID
npx wrangler secret put CF_ACCESS_CLIENT_SECRET
npx wrangler deploy
```

각 `secret put` 프롬프트에는 다음 값을 넣는다.

- `WEB_API_ORIGIN`: 별도 API origin의 HTTPS URL
- `CF_ACCESS_CLIENT_ID`: Access service token ID
- `CF_ACCESS_CLIENT_SECRET`: Access service token secret

## 10. 배포 후 확인

```bash
curl -i https://daejang.backwardlabs.io/api/v1/me

curl -i \
  'https://daejang.backwardlabs.io/api/v1/auth/oauth/naver/start?intent=login'

curl -i \
  'https://daejang.backwardlabs.io/api/v1/auth/oauth/google/start?intent=login'

curl -i \
  'https://daejang.backwardlabs.io/api/v1/auth/oauth/kakao/start?intent=login'
```

성공 기준:

- `/me`: HTML이 아닌 JSON `401`, `Cache-Control: no-store`
- Naver: `nid.naver.com`으로 향하는 `302`
- Google: `accounts.google.com`으로 향하는 `302`
- Kakao: `kauth.kakao.com`으로 향하는 `302`
- OAuth start 응답: `HttpOnly; Secure; SameSite=Lax` 거래 cookie

그다음 브라우저에서 provider별 실제 로그인과 callback을 한 번씩 완료한다. provider secret이나 사용자의 로그인 정보를 `curl` 명령에 직접 넣지 않는다.

## 11. 현재 의도적으로 막힌 운영 기능

다음 두 항목이 끝나기 전에는 운영 회원가입 완료를 열지 않는다.

1. 승인된 `terms`, `privacy`, `identity_verification` 전문을 DB에 등록
2. NICE 휴대전화 본인확인 callback과 결과 검증 연결

현재 운영 Compose는 `IDENTITY_VERIFICATION_MODE=disabled`다. 프론트의 `VITE_DEV_IDENTITY_MOCK_ENABLED`도 운영에서 `false`여야 한다.

여러 소셜 로그인 수단을 한 GIWA 계정에 추가·재인증·해제하는 API와 UI는 별도 후속 작업이다. DB의 provider identity 중복 방지 제약만 이번 배포에 포함된다.

## 12. 롤백 원칙

- 프론트·Web API 문제는 직전 정상 image 또는 commit으로 되돌린다.
- DB migration `000015`는 운영 데이터가 기록된 뒤 `down`하지 않는다.
- schema 문제가 있으면 새 migration으로 forward-fix한다.
- `docker compose down --volumes`는 운영 DB 데이터를 지우므로 운영 서버에서 실행하지 않는다.
