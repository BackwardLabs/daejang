# GIWA MVP 서버 배포 가이드

이 문서는 서버의 기존 checkout을 그대로 사용해 PostgreSQL을 먼저 갱신하고,
그 다음 GIWA API stack을 배포하는 절차다. 서버에서는 로컬 개발용 `git worktree`를
사용하지 않는다.

배포 대상 경로는 다음 두 곳이다.

| 구분 | 서버 경로 | 실제 환경 파일 |
| --- | --- | --- |
| DB | `/Users/Shared/Projects/01_Daejang/daejang-db` | `daejang-db/.env` |
| App·API·Engine | `/Users/Shared/Projects/01_Daejang/daejang` | `daejang/deploy/production.env` |

Git pull은 코드, migration, Compose 설정만 갱신한다. `.env`, 인증서, API key,
실행 중인 container와 PostgreSQL data volume은 Git으로 전송되지 않는다.
`daejang-db`를 다시 clone하거나 migration contract를 별도로 복사할 필요도 없다.
최종 DB 변경이 병합된 `daejang-db/main`을 pull하면 migration `000001`부터
`000030`까지 함께 들어온다.

## 이번 MVP의 운영 결정

이번 MVP는 외부 본인확인 provider 없이 가입 절차를 연다.

```dotenv
SIGNUP_ENABLED=true
IDENTITY_VERIFICATION_MODE=disabled
UPBIT_PDF_IMPORT_ENABLED=false
```

`IDENTITY_VERIFICATION_MODE=disabled`는 사용자를 본인확인 완료 상태로 만드는 설정이
아니다. 가입과 필수 약관 동의만 완료할 수 있게 한다. NICE 결과가 없으므로
verified subject name claim을 임의로 만들거나
`account:provision-subject-claim`으로 우회해서는 안 된다. 이름 일치가 필요한
Upbit PDF 가져오기도 `UPBIT_PDF_IMPORT_ENABLED=false`로 유지한다.

## 배포를 멈춰야 하는 경우

다음 중 하나라도 해당하면 pull이나 migration을 진행하지 않는다.

- DB 또는 App checkout에 누가 만든 것인지 모르는 미커밋 변경이 있다.
- 두 checkout 중 하나가 `main`이 아니거나 remote가 예상한 GitHub 저장소가 아니다.
- 현재 App stack이 어느 Compose 파일과 env source로 실행됐는지 확인되지 않았다.
- PostgreSQL backup과 복구 책임자가 정해지지 않았다.
- `wi11y` 계정이 저장소 파일을 읽고 쓸 수 없거나 Docker를 사용할 수 없다.
- 최종 DB PR과 최종 App PR이 아직 `main`에 병합되지 않았다.

특히 현재 서버 확인 결과에서는 `daejang-db/.env`가 존재하지만,
`daejang/deploy/production.env`는 관찰되지 않았다. 현재 stack이 다른 env source를
사용할 수 있으므로, 실행 경로를 확인하기 전에 예시 파일을 복사해 새
`production.env`를 만들지 않는다.

## 1. 서버 관리자가 공유 권한을 한 번 정리한다

현재 일부 파일은 `wiimdy:daejang` 소유이면서 mode가 `600`이라 같은
`daejang` 그룹의 다른 사용자가 읽을 수 없다. 아래 블록은 서버 관리자 또는 파일
소유자만 실행한다.

먼저 사용자가 그룹에 들어 있는지 확인한다.

```bash
id -Gn wi11y
```

출력에 `daejang`이 없다면 macOS 서버 관리자가 추가한 뒤 `wi11y`가 SSH에 다시
접속한다.

```bash
sudo dseditgroup -o edit -a wi11y -t user daejang
```

그 다음 두 checkout을 그룹 공동 작업 형태로 맞춘다.

```bash
export GIWA_SERVER_ROOT=/Users/Shared/Projects/01_Daejang

sudo chgrp -R daejang \
  "$GIWA_SERVER_ROOT/daejang" \
  "$GIWA_SERVER_ROOT/daejang-db"

sudo chmod -R g+rwX \
  "$GIWA_SERVER_ROOT/daejang" \
  "$GIWA_SERVER_ROOT/daejang-db"

sudo find \
  "$GIWA_SERVER_ROOT/daejang" \
  "$GIWA_SERVER_ROOT/daejang-db" \
  -type d -exec chmod g+s {} +

sudo -u wiimdy git -C "$GIWA_SERVER_ROOT/daejang" \
  config core.sharedRepository group
sudo -u wiimdy git -C "$GIWA_SERVER_ROOT/daejang-db" \
  config core.sharedRepository group

sudo chmod 660 "$GIWA_SERVER_ROOT/daejang-db/.env"
if [ -f "$GIWA_SERVER_ROOT/daejang/deploy/production.env" ]; then
  sudo chmod 660 "$GIWA_SERVER_ROOT/daejang/deploy/production.env"
fi
```

`chmod 777`은 사용하지 않는다. 비밀 파일은 `daejang` 그룹만 읽고 쓸 수 있는
`660`으로 두고, 디렉터리의 setgid bit로 새 파일이 같은 그룹을 상속하게 한다.
새 pull 이후 owner-only 파일이 다시 생기면 서버 관리자가 해당 파일에만
`g+rw`를 추가한다.

별도로 `wi11y`는 다음 권한이 필요하다.

- 두 private GitHub 저장소를 fetch할 SSH/GitHub 권한
- Docker daemon과 Docker Compose를 사용할 권한
- App image build 중 private `daejang-db` Go module을 읽을 GitHub token
- 운영 secret과 인증서 경로를 읽을 `daejang` 그룹 권한

## 2. 현재 서버 상태를 읽기 전용으로 확인한다

SSH 접속 직후 아래 명령만 실행한다. 이 단계는 파일이나 container를 바꾸지 않는다.

```bash
ssh -A giwa

export GIWA_SERVER_ROOT=/Users/Shared/Projects/01_Daejang
export GIWA_DB_DIR="$GIWA_SERVER_ROOT/daejang-db"
export GIWA_APP_DIR="$GIWA_SERVER_ROOT/daejang"

id

git -C "$GIWA_DB_DIR" status --short --branch
git -C "$GIWA_DB_DIR" branch --show-current
git -C "$GIWA_DB_DIR" remote get-url origin

git -C "$GIWA_APP_DIR" status --short --branch
git -C "$GIWA_APP_DIR" branch --show-current
git -C "$GIWA_APP_DIR" remote get-url origin

docker version
docker compose version
docker compose ls
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

test -f "$GIWA_DB_DIR/.env" \
  && echo "DB env: found" \
  || echo "DB env: missing"

test -f "$GIWA_APP_DIR/deploy/production.env" \
  && echo "App env: found" \
  || echo "App env: missing"
```

`docker compose ls`의 project name과 config file을 현재 운영자에게 확인한다.
실행 중인 App stack이 다른 checkout, 별도 service manager 또는 별도 env file을
사용한다면 그 경로가 이번 배포의 기준이다. 값을 확인하려고
`docker inspect`의 전체 환경변수를 채팅이나 이슈에 붙이지 않는다.

초기 SSH에서
`Could not resolve hostname backward-labs.tail344fa1.ts.net`가 나오고 재시도에
성공했다면 일시적인 Tailscale MagicDNS 상태일 수 있다. 반복되면 권한 변경보다 먼저
Tailscale 연결과 `giwa` SSH alias의 hostname을 확인한다.

## 3. DB 코드를 먼저 갱신한다

최종 DB PR이 병합된 뒤에만 실행한다. server checkout이 clean한 상태에서
`main`을 fast-forward한다.

```bash
git -C "$GIWA_DB_DIR" fetch origin
git -C "$GIWA_DB_DIR" checkout main
git -C "$GIWA_DB_DIR" pull --ff-only origin main
git -C "$GIWA_DB_DIR" rev-parse HEAD
```

여기까지는 PostgreSQL data를 바꾸지 않는다. migration 적용 전에 운영 DB backup과
복구 위치를 운영 책임자와 확인한다. 운영 데이터가 들어 있다면 backup 없이 다음
단계로 넘어가지 않는다.

## 4. 기존 DB env에 필요한 값만 보충한다

`daejang-db/.env`는 이미 있으므로 `.env.example`로 덮어쓰지 않는다. 먼저 값 자체를
출력하지 않고 필요한 key의 존재 여부만 확인한다.

```bash
cd "$GIWA_DB_DIR"

for key in \
  POSTGRES_DB \
  POSTGRES_PORT \
  POSTGRES_USER \
  POSTGRES_PASSWORD \
  DAEJANG_WEB_APP_PASSWORD \
  DAEJANG_IDENTITY_PROVISIONER_PASSWORD \
  DAEJANG_JIT_APP_PASSWORD \
  DAEJANG_SOURCE_APP_PASSWORD \
  DAEJANG_QUERY_APP_PASSWORD \
  DAEJANG_EVENT_APP_PASSWORD \
  DAEJANG_LOT_APP_PASSWORD \
  DAEJANG_TAX_APP_PASSWORD
do
  grep -q "^${key}=" .env || echo "MISSING: ${key}"
done
```

`MISSING`으로 나온 key만 기존 `.env`에 추가한다. 실제 password는
`.env.example`의 로컬 기본값이 아니라 운영용으로 생성한 서로 다른 값을 사용한다.
편집이 끝나면 값은 출력하지 말고 권한만 확인한다.

```bash
chmod 660 .env
ls -l .env
```

## 5. migration 1~30을 적용하고 검증한다

DB Compose project가 PostgreSQL, runtime role bootstrap과 migration job을
관리한다. App이 schema migration을 대신 실행하지 않는다.

```bash
cd "$GIWA_DB_DIR"

docker compose config --quiet
make check
make database-up
make database-status
make database-verify
docker compose ps
```

다음이 모두 확인되어야 App 단계로 넘어간다.

- PostgreSQL container가 `healthy`
- migration `000001`부터 `000030`까지 적용됨
- runtime role 검증 성공
- Web OAuth·email persistence 검증 성공
- Docker network `daejang-db_default`가 존재함

```bash
docker network inspect daejang-db_default >/dev/null
```

실패한 migration을 `down`으로 되돌리거나 운영 volume을 삭제하지 않는다.
`docker compose down --volumes`도 실행하지 않는다. 원인을 수정한 새 migration으로
forward-fix하는 것이 원칙이다.

## 6. App의 실제 env source를 확정한다

현재 `deploy/production.env`가 없는 상태라면 여기서 운영 책임자에게 현재 App stack이
사용한 env source를 확인한다. 다른 파일이나 secret manager가 기준이면 그 값을
`production.env`로 임의 복사하지 말고 기존 배포 방식을 유지한다.

운영 책임자가 `daejang/deploy/production.env`를 이번 Compose의 기준으로 확정했고
파일이 실제로 없을 때만 다음과 같이 만든다.

```bash
cd "$GIWA_APP_DIR"

umask 007
cp deploy/production.env.example deploy/production.env
chmod 660 deploy/production.env
```

복사 직후의 파일에는 placeholder가 있으므로 아직 App을 시작하면 안 된다.
실제 값을 입력할 때는 다음 범주를 모두 확인한다.

- 공개 origin과 NGINX TLS 인증서
- DB 역할별 DSN과 `DAEJANG_DB_NETWORK=daejang-db_default`
- session, rate-limit, OAuth transaction용 서로 다른 secret
- Naver, Google, Kakao client ID·secret
- Resend API key와 `EMAIL_FROM`
- Engine·Web API·health probe의 mTLS 인증서
- JIT bridge 설정과 mTLS 인증서
- private Go module build용 GitHub token은 파일이 아니라 build shell에만 주입

이번 MVP flag는 다음 값이어야 한다.

```dotenv
SIGNUP_ENABLED=true
IDENTITY_VERIFICATION_MODE=disabled
UPBIT_PDF_IMPORT_ENABLED=false
```

필수 약관 전문은 migration이 자동으로 만들지 않는다. 법무 검토가 끝난 현재
`terms`, `privacy`, `identity_verification` 문서를 운영 DB에 등록하는 승인된
one-shot 절차가 별도로 필요하다. 이 문서가 없으면 가입 과정은
`LEGAL_DOCUMENTS_UNAVAILABLE`로 중단된다. 로컬 fixture를 운영 DB에 넣지 않는다.

## 7. App 코드를 갱신하고 Compose를 검증한다

최종 App PR이 병합된 뒤에만 실행한다.

```bash
git -C "$GIWA_APP_DIR" fetch origin
git -C "$GIWA_APP_DIR" checkout main
git -C "$GIWA_APP_DIR" pull --ff-only origin main
git -C "$GIWA_APP_DIR" rev-parse HEAD
```

App image build는 private `BackwardLabs/daejang-db` Go module을 읽는다.
Contents read 권한만 가진 token을 shell에 일시적으로 입력하고 파일에 저장하지 않는다.

```bash
cd "$GIWA_APP_DIR"

read -r -s -p "GitHub token: " GH_PAT
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
```

`config --quiet` 또는 build가 실패하면 기존 container는 건드리지 않고 중단한다.

## 8. App stack을 갱신한다

DB 검증과 App build가 모두 끝난 뒤에만 실행한다.

```bash
cd "$GIWA_APP_DIR"

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  up -d

docker compose \
  --env-file deploy/production.env \
  --file deploy/compose.production.yaml \
  ps
```

`nginx`, `web-api`, `engine`, `pdf-parser`, `sync-worker`가 실행되어야 한다.
Web API는 DB와 Engine이 준비되지 않으면 `/readyz`에서 `503`을 반환하도록
fail-closed되어 있다.

## 9. 서버 API를 검증한다

먼저 서버 내부에서 상태를 확인하고, 그 다음 공개 edge를 확인한다. 실제 내부 API
hostname은 현재 운영 구성을 사용한다.

```bash
curl -i https://daejang.backwardlabs.io/api/v1/me
curl -i https://daejang.backwardlabs.io/api/v1/auth/capabilities

for provider in naver google kakao; do
  curl -sS -D - -o /dev/null \
    "https://daejang.backwardlabs.io/api/v1/auth/oauth/${provider}/start?intent=signup"
done
```

성공 기준은 다음과 같다.

- 비로그인 `/api/v1/me`는 HTML이 아닌 JSON `401` 반환
- capabilities에서 signup이 활성화되고 email과 설정된 OAuth provider가 표시됨
- Naver, Google, Kakao 시작 요청은 각 provider의 공식 인증 주소로 `302`
- OAuth callback 후 새 GIWA 계정 생성, 필수 약관 동의, dashboard 진입 가능
- 기존 이메일로 다시 가입할 때 새 인증번호를 보내지 않고 기존 계정 안내
- 로그아웃한 session cookie로 보호 API에 다시 접근할 수 없음
- `UPBIT_PDF_IMPORT_ENABLED=false` 상태에서 PDF 가져오기 경로가 열리지 않음

실제 provider 로그인, Resend 수신, callback과 cookie 회전은 단순 `curl`만으로
완료 검증할 수 없다. 브라우저에서 provider별로 가입과 재로그인을 한 번씩 확인한다.

## 10. Cloudflare 프런트 배포는 별도다

서버의 `deploy/compose.production.yaml`은 NGINX, Web API, Engine과 worker를
운영한다. 프런트 정적 build와 Cloudflare edge는 이 Compose에 포함되지 않는다.

따라서 App PR을 merge하고 서버에서 `main`을 pull해도 공개 웹 화면이 자동으로
바뀌지는 않는다. 서버 API 검증이 끝난 뒤 기존 Cloudflare 배포 workflow로 같은
App commit의 프런트와 edge를 별도 배포해야 한다. Cloudflare의 API origin은 공개
웹 주소 자체가 아니라 서버 NGINX로 연결되는 기존 비공개 origin 설정을 유지한다.

## 롤백과 금지 사항

- App 문제는 직전 정상 App image 또는 commit으로 되돌릴 수 있다.
- 적용된 DB migration은 `down`하지 않고 새 migration으로 forward-fix한다.
- 운영 PostgreSQL·artifact volume에 `docker compose down --volumes`를 실행하지 않는다.
- `.env`를 Git에 add, commit, PR 또는 채팅으로 올리지 않는다.
- `IDENTITY_VERIFICATION_MODE=mock`을 운영에서 사용하지 않는다.
- NICE 결과 없이 verified subject name claim을 만들지 않는다.
- 운영 약관 대신 로컬 fixture를 등록하지 않는다.
- 현재 stack과 env source를 확인하지 않은 상태에서 새 stack을 나란히 띄우지 않는다.
