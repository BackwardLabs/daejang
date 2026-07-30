# Host backend supervisor

같은 서버에서 실행되는 PostgreSQL, PDF parser, Ethereum/Optimism JIT, Engine,
sync worker, SOURCE/CEX Posting worker, Web API를 Docker 애플리케이션 이미지 없이
한 명령으로 관리한다.
PostgreSQL만 기존 `daejang-db` Compose 서비스를 사용한다.

## 준비

- `daejang-db/.env`
- `daejang/deploy/production.env`
- `daejang-jit-engine/.envrc`
- `daejang-posting-service` checkout (기존 호스트의 `evm-posting-service` 이름도 지원)
- Ethereum/Optimism을 모두 포함한 JIT bridge JSON
- 빌드된 `daejang-jit-runtime/bin/jitd`, `daejang-jit-runtime/bin/cue`
- PDF parser Python 가상환경

`daejang-db/.env`의 runtime role 비밀번호를 바꾼 경우에는 backend를 시작하기
전에 DB 저장값을 운영 절차에 따라 회전하고 migration/role 검증을 완료해야 한다.
`backend:start`는 애플리케이션 시작 명령이므로 role 비밀번호나 schema를 자동
변경하지 않는다.

bridge JSON은 기본적으로 아래 경로에 두며 secret으로 취급하지 않지만 runtime
산출물이므로 Git에는 커밋하지 않는다.

기본 runtime root는 Git checkout 밖의
`~/Library/Application Support/GIWA/production`이다. bridge JSON은 그 아래
`supervisor/config/jit-bridge.json`에 둔다. 운영 데이터가 checkout/worktree 정리와
함께 삭제되지 않도록 checkout 내부 경로는 거부한다.

실행기는 bridge의 `endpoint`를 실제 통합 JIT Unix socket으로 자동 교체한다.
현재 coverage 범위와 chain metadata는 입력 JSON을 그대로 사용한다.

### JIT subject ACL

JIT는 호출자의 peer identity와 요청의 `subject_id`를 함께 검사한다. 기본 ACL은
`daejang-jit-runtime/configs/subject-acl.json`을 사용한다. 운영 서버에서 저장소 ACL을
직접 수정할 수 없거나 사용자 subject를 별도로 승인해야 하면 runtime root의
`supervisor/config/subject-acl.source.json`에 운영자 소유 override를 둔다. 이 파일이
있으면 기본 ACL보다 우선한다.

override는 `version: 1`과 정확히 하나의 로컬 `uid:<number>` grant를 포함해야 한다.
backend 시작 시 그 identity만 현재 서비스 UID로 재작성하여
`subject-acl.runtime.json`을 권한 `0600`으로 생성한다. `subjects`에는 승인된 subject ID를
명시적으로 나열하며 wildcard나 전체 허용 grant를 사용하지 않는다. subject ID는 운영
식별자이므로 override를 Git이나 로그에 남기지 않고 감사 가능한 provisioning 절차로만
추가한다.

JIT는 ACL을 시작 시점에 snapshot으로 읽으므로 override 변경 후 backend를 재시작해야
한다. ACL 거부로 실패한 sync job은 원본 실패 이력을 수정하지 말고, 재시작과 readiness
확인 후 인증된 재수집 경로로 새 작업을 생성한다.

## 명령

```bash
npm run backend:start
npm run backend:status
npm run backend:logs
npm run backend:restart
npm run backend:stop
npm run backend:install-autostart
```

`backend:start`는 Web API와 Go 바이너리를 먼저 빌드한 뒤 의존 순서대로
서비스를 시작하고 readiness를 확인한다. 중간 단계가 실패하면 이미 시작한
프로세스를 정리한다. PID 상태에는 실행 명령 신원도 함께 기록하여 재부팅 후 PID가
재사용된 경우 다른 프로세스를 종료하지 않는다. `backend:install-autostart`는 macOS
LaunchAgent를 설치하고, 로그인/재부팅 후 supervisor가 전체 서비스를 다시 올리며
중간 프로세스가 종료되거나 readiness가 실패하면 전체 dependency set을 prebuilt
artifact로 재시작한다. 이 호스트처럼 LaunchAgent domain이 비활성화된 경우에는
동일한 stable runtime launcher를 사용자 crontab의 `@reboot`에 등록한다.

`backend:stop`은 pause marker를 먼저 기록하므로 supervisor가 서비스를 즉시 다시
올리지 않는다. `backend:start` 또는 `backend:restart`가 전체 readiness를 통과한
뒤 pause를 해제한다. supervisor singleton lock은 monitor가 둘 이상 PID와 socket을
동시에 조작하지 못하게 한다. build는 명시적인 start/restart 때만 수행하며 장애
복구 loop는 runtime root의 prebuilt Go binaries, Web API dist, proto를 재사용한다.

Posting worker는 `SOURCE` publication을 소비해 CEX Event·Posting·Relation을
원자적으로 저장한다. JIT/EVM canonical writer는 별도의 단일-writer 전환 대상이므로
이 supervisor가 자동으로 활성화하지 않는다. shadow parity, 기존 Tax Engine writer
stop/drain, 서명된 publication claim policy 검증이 끝난 뒤에만 전환한다.

Web API만 `127.0.0.1:3000`을 listen한다. Engine은 외부 TCP 포트를 열지 않고
권한 `0700` socket directory 안의 소유자 전용 Unix socket(`0600`)으로만 Web API와
통신한다. 따라서 같은 호스트 배포에서 별도 mTLS 인증서를 운영하지 않는다.

PDF parser 프로세스는 항상 시작한다. production PDF 업로드를 켤 때는
`UPBIT_PDF_IMPORT_ENABLED=true`와 base64 32-byte
`PRIVATE_OBJECT_ENCRYPTION_KEY`와 `PRIVATE_OBJECT_ENCRYPTION_KEY_ID`를 함께
설정한다. Web API private object와 Engine source artifact의 원본 PDF는 모두 key ID가
포함된 AES-256-GCM envelope로만 저장된다. worker는 필요한 시점에 메모리에서만
복호화한다. object key를 인증 데이터로 묶으므로 파일 경로가 바뀌면 복호화가
실패한다. 키를 교체할 때 이전 key ID와 key는 `PRIVATE_OBJECT_DECRYPTION_KEYS` JSON
객체에 유지한다. 기존 `GIWAOBJ1` object가 있으면 그 key ID를
`PRIVATE_OBJECT_LEGACY_KEY_ID`로 명시해야 한다. 기존 object의 재암호화가 끝날 때까지
이전 key를 제거하지 않는다.

경로를 바꿔야 할 때는 다음 환경 변수를 사용한다.

- `GIWA_DATABASE_REPOSITORY`
- `GIWA_JIT_REPOSITORY`
- `GIWA_JIT_RUNTIME`
- `GIWA_POSTING_REPOSITORY`
- `GIWA_HOST_RUNTIME_ROOT`
- `GIWA_HOST_SOCKET_ROOT`
- `GIWA_JIT_BRIDGE_CONFIG`
- `GIWA_PDF_PARSER_PYTHON`
- `GIWA_EVM_INDEXER_BINARY`
- `GIWA_EVM_INDEXER_CONFIG`
- `GIWA_EVM_INDEXER_ENV_FILE`
- `PRIVATE_OBJECT_ENCRYPTION_KEY`
- `PRIVATE_OBJECT_ENCRYPTION_KEY_ID`
- `PRIVATE_OBJECT_LEGACY_KEY_ID`
- `PRIVATE_OBJECT_DECRYPTION_KEYS`

Optimism 전용 RPC가 없으면 `https://mainnet.optimism.io`를 사용한다. 지속적인
운영 부하에는 rate limit이 보장되는 전용 endpoint를 설정한다.
