# Tailscale Docker Registry 운영

이 구성은 공유기 port forwarding이나 공개 DNS 없이 팀 전용 Docker Registry를
운영한다. Registry는 Mac Studio의 `127.0.0.1:5050`에만 열리고, Tailscale
Serve가 Tailnet 내부 HTTPS 443을 이 loopback 주소로 전달한다.

```text
개발자 Docker client
    │ Tailscale 로그인 + HTTPS
    ▼
Mac Studio의 자동 MagicDNS 이름
    │ Tailscale Serve
    ▼
127.0.0.1:5050 ──► Docker Registry ──► image data
                         │
                         └─ bcrypt htpasswd 로그인
```

접근하려면 두 조건을 모두 만족해야 한다.

1. 개발자 장비가 같은 Tailnet에 연결되어 있어야 한다.
2. `docker login`에서 Registry 사용자명과 비밀번호를 입력해야 한다.

## 처음 시작

```bash
cd /Users/Shared/Projects/01_Daejang/daejang/deploy/registry
make init
make user USER=developer
make up
```

`make up`은 다음 작업을 순서대로 수행한다.

1. bcrypt 사용자가 존재하는지 확인한다.
2. Registry를 loopback port에 실행한다.
3. 현재 Tailscale MagicDNS 이름을 자동 조회한다.
4. Tailscale Serve HTTPS 443을 Registry에 연결한다.

처음 Tailscale HTTPS를 사용할 때 관리자 화면에서 HTTPS Certificates 활성화를
요구할 수 있다. 화면의 안내를 한 번 승인하면 Serve 설정은 재부팅 뒤에도
복구된다.

## DNS 이름 확인과 로그인

DNS 이름을 설정 파일에 복사하지 않고 Tailscale 상태에서 매번 읽는다.

```bash
REGISTRY_HOST="$(make -s endpoint)"
docker login "$REGISTRY_HOST"
```

현재 이 Mac에서 조회되는 주소는 다음과 같지만, 명령에서는 고정하지 않는다.

```text
backwardlabss-mac-studio.tail344fa1.ts.net
```

Docker Desktop은 로그인 정보를 macOS Keychain에 저장한다. Registry 주소에는
`https://`나 `/v2/` 경로를 붙이지 않고 hostname만 사용한다.

이 공용 Mac처럼 Docker Desktop을 실행한 OS 계정과 현재 shell 계정이 다르고
현재 계정에 기본 Keychain이 없으면 `docker login`이 `Keychain Error (-60008)`로
끝날 수 있다. 이때는 다음 명령을 사용한다.

```bash
make client-login
```

이 명령은 Registry에서 사용자명과 비밀번호를 먼저 검증한 뒤 현재 사용자의
`~/.docker/config.json`에 해당 Registry 항목만 저장한다. Keychain을 사용할 수
없으므로 값은 Docker 표준 base64 형식이며 암호화가 아니다. 디렉터리는 `700`,
파일은 `600`으로 제한된다. 로그아웃은 `make client-logout`을 사용한다. 개인
개발 장비에서 Keychain이 정상 동작하면 일반 `docker login`을 그대로 사용한다.

## Image push와 pull

```bash
REGISTRY_HOST="$(make -s endpoint)"

docker tag my-image:dev \
  "$REGISTRY_HOST/daejang/posting-service:sha-0123456"
docker push \
  "$REGISTRY_HOST/daejang/posting-service:sha-0123456"
docker pull \
  "$REGISTRY_HOST/daejang/posting-service:sha-0123456"
```

E2E lock file에는 tag가 아니라 push 결과의 digest를 기록한다.

```text
<MagicDNS 이름>/daejang/posting-service@sha256:...
```

## 핵심 E2E 기준 image 세트

다음 6개 image를 현재 각 저장소의 commit에서 `linux/arm64`로 build하고 Registry에
push한다.

- `web-api`
- `engine`
- `pdf-parser`
- `jit-engine`
- `posting-service` — SOURCE·EVM worker를 모두 포함한다.
- `tax-engine`

```bash
make images-publish
```

공용 checkout 자체에서는 build하지 않는다. 스크립트가 각 commit을 `/tmp`의
격리된 checkout으로 복제한 뒤 build하고 제거한다. private GitHub module token은
현재 `gh` 로그인의 token을 BuildKit secret으로만 전달하며 image layer나 lock에
기록하지 않는다.

push가 모두 끝나면 `e2e/images.lock.json`에 tag, source commit과 OCI digest를
기록한다. 다른 개발자는 lock에 기록된 같은 bytes를 한 번에 받을 수 있다.

```bash
make images-list
make images-pull
```

`make images-pull`은 digest reference로 pull한 뒤 모든 image가 `linux/arm64`인지
검증한다. 기능 branch의 candidate image는 이 기준 세트를 덮어쓰지 않고 로컬에서
별도 tag로 build해 해당 서비스 하나만 교체한다.

## main 자동 publisher

GitHub Actions가 이 Registry에 접속하는 대신 Mac Studio가 GitHub의 네 private
repository `main` commit을 2분마다 확인한다. 변경된 repository만 GitHub API에서
임시 directory로 받고 native `linux/arm64` image를 build한다.

```text
GitHub main
   │ outbound polling
   ▼
Mac Studio publisher
   ├─ isolated source download
   ├─ 변경된 repository image를 모두 먼저 build
   └─ build가 모두 성공하면 latest만 push
```

설치 전에 현재 OS 사용자에서 `gh auth status`, `docker info`, Registry 로그인이
모두 성공해야 한다. publisher는 이 사용자의 `gh`와 Docker credential을 사용하지만
token 원문을 state나 log에 남기지 않는다.

```bash
make publisher-run       # foreground에서 한 번 확인·게시
make publisher-install   # 2분 주기 scheduler 설치
make publisher-status    # launchd와 마지막 성공 commit 확인
make publisher-logs      # stdout/stderr log 확인
make publisher-uninstall # agent만 제거; state와 log는 보존
make images-cleanup-dry-run # 삭제 없이 정리 대상과 GC 결과 확인
make images-cleanup      # 과거 digest 정리와 GC 즉시 실행
```

상태와 log는 Git checkout 밖에 둔다.

```text
/Users/Shared/DaejangRegistry/publisher/state.json
/Users/Shared/DaejangRegistry/logs/publisher.stdout.log
/Users/Shared/DaejangRegistry/logs/publisher.stderr.log
/Users/Shared/DaejangRegistry/logs/cleaner.stdout.log
/Users/Shared/DaejangRegistry/logs/cleaner.stderr.log
```

일반 GUI login session에서는 user launchd를 사용한다. SSH·Codex 같은 macOS
Background session에서 launchd bootstrap domain을 사용할 수 없으면 installer가 같은
2분 주기의 user crontab으로 자동 전환한다. 두 방식 모두 root 권한이 필요하지 않으며
publisher의 process lock이 중복 실행을 막는다.

한 repository의 build 또는 push가 실패하면 그 repository의 성공 commit을 갱신하지
않고 다음 주기에 다시 시도한다. source version은 Git commit으로 관리하고 Registry에는
각 image의 `latest`만 새로 게시한다. 운영·E2E 기록에는 mutable tag 대신 게시 결과의
digest를 사용한다.

매일 04:15에는 cleaner가 publisher와 같은 process lock을 잡고 교체 전 digest만
Registry API로 삭제한다. 이어서 Registry를 잠시 중지하고 garbage collection을 실행한
뒤 바로 다시 시작한다. 현재 `latest` digest는 삭제 대상에 넣지 않으며, 삭제 도중 오류가
나도 trap이 Registry를 다시 시작한다. 첫 적용과 변경 후에는 `make
images-cleanup-dry-run`으로 먼저 확인한다.

## 확인과 운영 명령

```bash
make endpoint         # 현재 MagicDNS hostname 출력
make status           # Registry와 Tailscale Serve 상태
make verify-local     # loopback에서 비로그인 401 확인
make verify-tailnet   # Tailnet HTTPS에서 비로그인 401 확인
make logs             # Registry 로그
make restart          # Registry 재시작
make expose           # Tailscale 연결만 다시 생성
make unexpose         # Tailscale 연결 해제
make down             # 연결 해제 후 Registry 중지
```

`make expose`는 기존 Tailscale Serve 설정이 다른 서비스를 가리키면 덮어쓰지 않고
중단한다. 이 Mac에서 다른 Serve 서비스를 운영해야 한다면 별도 Tailscale Service
또는 path 구성을 먼저 설계한다.

## 사용자와 권한

사용자를 추가하거나 비밀번호를 변경한다.

```bash
make user USER=wonmin
```

비밀번호 원문은 파일이나 명령행에 저장하지 않고 bcrypt 해시만
`REGISTRY_AUTH_DIR/htpasswd`에 남긴다.

native `htpasswd`는 사용자별 pull-only/push 권한을 강제하지 않는다. credential은
Mac Studio publisher와 승인된 팀원에게만 전달한다. 서버가 강제하는 repository별
RBAC가 필요하면 Harbor나 token authorization service를 사용한다.

## 외부 자동화에서 pull해야 할 때

main image 게시에는 GitHub Actions를 사용하지 않으므로 GitHub repository나
organization에 Registry variable, Tailscale OAuth secret을 등록할 필요가 없다.
별도의 외부 자동화가 image를 pull해야 한다면 runner를 먼저 Tailnet에 연결하고,
Registry 비밀번호를 표준 입력으로 전달한다.

```bash
printf '%s' "$REGISTRY_PASSWORD" | \
  docker login "$REGISTRY_HOST" \
    --username "$REGISTRY_USERNAME" \
    --password-stdin
```

Tailscale auth key와 Registry 비밀번호는 서로 다른 secret으로 관리한다. PR에서
실행되는 제3자 코드에는 두 secret을 전달하지 않는다.

## 데이터와 복구

image와 bcrypt 해시는 Git checkout 밖의 다음 기본 경로에 저장한다.

```text
/Users/Shared/DaejangRegistry/data
/Users/Shared/DaejangRegistry/auth
```

백업 대상은 `REGISTRY_DATA_DIR` 전체다. `make down`은 image data를 삭제하지 않는다.
서버 재부팅 뒤 Docker Desktop과 Tailscale이 시작되는지, `make status`와
`make verify-tailnet`이 통과하는지 확인한다.
