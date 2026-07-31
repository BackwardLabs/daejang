# Host backend supervisor

같은 서버에서 실행되는 PostgreSQL, PDF parser, Ethereum/Optimism JIT, Engine,
sync worker, SOURCE/CEX Posting worker, JIT/EVM Posting worker, Web API를 Docker
애플리케이션 이미지 없이 한 명령으로 관리한다.
PostgreSQL만 기존 `daejang-db` Compose 서비스를 사용한다.

## 준비

- `daejang-db/.env`
- `daejang/deploy/production.env`
- `daejang-jit-engine/.envrc`
- `daejang-posting-service` checkout (기존 호스트의 `evm-posting-service` 이름도 지원)
- runtime `supervisor/config/source-publication-claim-policy.json`
- canonical EVM writer를 켤 때 runtime
  `supervisor/config/evm-publication-claim-policy.json`
- Ethereum/Optimism을 모두 포함한 JIT bridge JSON
- `daejang-jit-engine` checkout과 빌드된 `daejang-jit-runtime/bin/cue`
- `executionGraph: true`와 현재 schema commit/module digest를 pin한
  `daejang-jit-engine/configs` JIT config
- pin과 일치하는 `schema` checkout
- signed ActionProfile release가 있는 `DeFi-Label` checkout
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
backend 시작 시 그 identity를 현재 서비스 UID로 재작성하고, 해당 grant를
`allowAnySubject: true`인 로컬 subject broker grant로 바꿔
`subject-acl.runtime.json`을 권한 `0600`으로 생성한다. dashboard subject는 가입 시점에
동적으로 만들어지므로 정적 사용자 목록으로 표현하지 않는다. 이 권한은 Unix peer
credential로 인증된 같은 UID의 sync worker에만 허용되며, 원격 mTLS identity에는 사용할
수 없다. 원격 grant는 계속 `subjects`에 승인 ID를 명시해야 한다. 따라서 이 설정은
익명 wildcard가 아니라 Web API 인증·wallet ownership 검증을 통과한 요청만 전달하는
로컬 broker trust boundary다.

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

`backend:start`는 Web API, JIT와 나머지 Go 바이너리를 먼저 빌드한 뒤 의존 순서대로
서비스를 시작하고 readiness를 확인한다. 중간 단계가 실패하면 이미 시작한
프로세스를 정리한다. PID 상태에는 실행 명령 신원도 함께 기록하여 재부팅 후 PID가
재사용된 경우 다른 프로세스를 종료하지 않는다. `backend:install-autostart`는 macOS
LaunchAgent를 설치하고, 로그인/재부팅 후 supervisor가 전체 서비스를 다시 올리며
중간 프로세스가 종료되거나 readiness가 실패하면 전체 dependency set을 prebuilt
artifact로 재시작한다. 이 호스트처럼 LaunchAgent domain이 비활성화된 경우에는
GUI domain 다음으로 background `user/<uid>` launchd domain을 사용한다. 두 launchd
domain과 legacy load가 모두 불가능한 경우에만 동일한 stable runtime launcher를
사용자 crontab의 `@reboot`에 등록하고 설치 즉시 detached supervisor를 시작한다.
1분 watchdog은 supervisor가 사라진 경우에만 이를 다시 시작한다.
설치 시에도 같은 lock watchdog을 먼저 실행하므로 이전 강제 종료의 stale lock이
남아 있어도 첫 1분 주기를 기다리지 않고 supervisor를 복구한다.
launchd와 cron에는 설치 세션의 임시 도구 경로를 복사하지 않고 Node, Homebrew,
시스템 도구와 OrbStack만 포함한 bounded `PATH`를 기록한다. 따라서 긴 개발 세션
환경 때문에 crontab 명령이 잘리거나 재부팅 후 실행 경로가 달라지지 않는다.

`backend:stop`은 pause marker를 먼저 기록하므로 supervisor가 서비스를 즉시 다시
올리지 않는다. `backend:start` 또는 `backend:restart`가 전체 readiness를 통과한
뒤 pause를 해제한다. supervisor singleton lock은 monitor가 둘 이상 PID와 socket을
동시에 조작하지 못하게 한다. build는 명시적인 start/restart 때만 수행하며 장애
복구 loop는 runtime root의 prebuilt Go binaries, Web API dist, proto를 재사용한다.
supervisor 자체가 launchd·cron·운영 세션의 종료 신호를 받는 경우에는 이미 정상
실행 중인 resident 서비스를 내리지 않는다. 명시적인 `backend:stop`과
`backend:restart`만 dependency set을 종료하며, watchdog은 다음 주기에 supervisor만
다시 연결한다. supervisor는 종료 신호 처리 후 singleton lock을 반납하고 stable
runtime script로 detached monitor를 직접 handoff하므로, cron 실행이 지연되거나
비활성화된 로그인 세션에서도 감시 공백을 남기지 않는다.
cron fallback의 1분 watchdog은 프로세스 이름 검색을 사용하지 않고 singleton lock에
기록된 PID와 실제 명령 신원을 검사한다. supervisor가 강제 종료되어 stale lock이
남아도 다른 프로세스가 해당 PID·명령을 소유하지 않음을 확인한 뒤 lock을 회수하고
monitor만 다시 시작한다.

SOURCE Posting worker는 `SOURCE` publication을 소비해 CEX Event·Posting·Relation을
원자적으로 저장한다. 시작 시 signed `normal-single-writer` policy로 한 번의 bounded
claim을 실행해 policy·trust key·DB 권한·materialization을 검증한 뒤 continuous worker를
올린다. `DAEJANG_PUBLICATION_POLICY_TRUST_KEY`는 policy를 서명한 Ed25519 key의
raw-base64url public key여야 한다.

JIT/EVM worker는 `SubjectEvidencePublished/JIT` publication의 sealed ActionProof만
소비한다. runtime config의 `schema.executionGraph`가 켜져 있고 `jitd`가
`--defi-label-dir`로 signed profile release를 읽어야 ActionProof가 생긴다. supervisor는
`evm-publication-claim-policy.json`이 존재할 때만 canonical EVM worker를 dependency set에
포함한다. policy가 없으면 JIT와 Observation 수집은 계속 동작하지만 EVM Posting은
명시적으로 disabled 상태다. policy가 있으면 시작 전 one-shot claim 검증에 실패할 경우
전체 start를 fail-closed 한다. 기존 EVM writer를 stop/drain하고 단일 writer임을 확인한 뒤
운영자가 서명 policy를 provision하고 backend를 재시작해야 한다.

Tax Engine은 canonical ledger의 downstream consumer다. 아직 canonical asset
Posting이 하나도 없는 초기 배포에서는 `taxd`만 명시적으로 disabled 상태로 두고
JIT·Engine·sync worker·Posting worker·Web API는 정상 기동한다. 첫 canonical Posting이
생긴 뒤 `backend:restart`하면 subject별 downstream profile을 다시 생성하고 `taxd`를
활성화한다. 초기 tax profile 부재가 upstream evidence 수집을 중단시켜서는 안 된다.

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
- `GIWA_SCHEMA_REPOSITORY`
- `GIWA_JIT_RUNTIME`
- `GIWA_DEFI_LABEL_REPOSITORY`
- `GIWA_JIT_ARTIFACT_ROOT`
- `GIWA_JIT_ARTIFACT_TEMP`
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
