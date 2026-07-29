# Host backend supervisor

같은 서버에서 실행되는 PostgreSQL, PDF parser, Ethereum/Optimism JIT, Engine,
sync worker, Web API를 Docker 애플리케이션 이미지 없이 한 명령으로 관리한다.
PostgreSQL만 기존 `daejang-db` Compose 서비스를 사용한다.

## 준비

- `daejang-db/.env`
- `daejang/deploy/production.env`
- `daejang-jit-engine/.envrc`
- Ethereum/Optimism을 모두 포함한 JIT bridge JSON
- 빌드된 `daejang-jit-runtime/bin/jitd`, `daejang-jit-runtime/bin/cue`
- PDF parser Python 가상환경

`daejang-db/.env`의 runtime role 비밀번호를 바꾼 경우에는 backend를 시작하기
전에 DB 저장값을 운영 절차에 따라 회전하고 migration/role 검증을 완료해야 한다.
`backend:start`는 애플리케이션 시작 명령이므로 role 비밀번호나 schema를 자동
변경하지 않는다.

bridge JSON은 기본적으로 아래 경로에 두며 secret으로 취급하지 않지만 runtime
산출물이므로 Git에는 커밋하지 않는다.

```text
.runtime/production/supervisor/config/jit-bridge.json
```

실행기는 bridge의 `endpoint`를 실제 통합 JIT Unix socket으로 자동 교체한다.
현재 coverage 범위와 chain metadata는 입력 JSON을 그대로 사용한다.

## 명령

```bash
npm run backend:start
npm run backend:status
npm run backend:logs
npm run backend:restart
npm run backend:stop
```

`backend:start`는 Web API와 Go 바이너리를 먼저 빌드한 뒤 의존 순서대로
서비스를 시작하고 readiness를 확인한다. 중간 단계가 실패하면 이미 시작한
프로세스를 정리한다. 로그와 PID는 `.runtime/production/supervisor` 아래에 남는다.

기본 listen 주소는 Web API `127.0.0.1:3001`, Engine `127.0.0.1:50051`이다.
둘은 같은 호스트의 loopback에서만 plaintext gRPC를 허용하며 외부 주소에는
mTLS 설정이 계속 필수다.

PDF parser 프로세스는 항상 시작하지만, Web API의 PDF 업로드 경로는
`UPBIT_PDF_IMPORT_ENABLED` 설정을 따른다. 승인된 암호화·감사·버전 object
storage가 없는 production에서는 기본값 `false`를 유지한다.

경로를 바꿔야 할 때는 다음 환경 변수를 사용한다.

- `GIWA_DATABASE_REPOSITORY`
- `GIWA_JIT_REPOSITORY`
- `GIWA_JIT_RUNTIME`
- `GIWA_HOST_RUNTIME_ROOT`
- `GIWA_HOST_SOCKET_ROOT`
- `GIWA_JIT_BRIDGE_CONFIG`
- `GIWA_PDF_PARSER_PYTHON`
- `GIWA_EVM_INDEXER_BINARY`
- `GIWA_EVM_INDEXER_CONFIG`
- `GIWA_EVM_INDEXER_ENV_FILE`

Optimism 전용 RPC가 없으면 `https://mainnet.optimism.io`를 사용한다. 지속적인
운영 부하에는 rate limit이 보장되는 전용 endpoint를 설정한다.
