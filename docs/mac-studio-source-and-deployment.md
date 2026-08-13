# Mac Studio 개발·배포 가이드

이 문서는 GIWA Daejang을 처음 맡은 팀원이 기존 개인 workspace나 worktree를 알지
못해도 변경을 제안하고, 승인된 운영자가 같은 변경을 Mac Studio에 재현할 수 있도록
하는 기준 절차다.

## 세 가지 경계

| 경계 | 정본 | 허용 작업 |
| --- | --- | --- |
| 소스코드 | GitHub 각 저장소의 `main` | PR로만 변경 |
| 배포 checkout | Mac Studio `/Users/Shared/Projects` | `main` fast-forward와 빌드·재시작만 수행 |
| 운영 데이터 | PostgreSQL, EVM index, quote archive, GIWA runtime root | Git 명령과 checkout 정리 대상에서 제외 |

EVM 인덱서의 원격 정본 이름은 `BackwardLabs/daejang-evm-indexer`다. 과거
`BackwardLabs/evm-indexer` URL의 redirect에 의존하지 않는다.

배포 checkout에서 코드를 수정하거나 브랜치를 만들지 않는다. 개인 노트북의 기존
worktree, 미병합 브랜치, ignored runtime 파일은 소스 정본도 배포 입력도 아니다.

## 일반 팀원의 작업

일반 팀원은 Mac Studio 관리자 또는 운영 데이터 접근 권한이 필요하지 않다.

1. 담당 저장소를 자신의 계정 아래 일반 clone으로 받는다.
2. 일반 branch 하나에서 수정한다. worktree는 사용하지 않아도 된다.
3. 관련 테스트와 빌드를 실행한다.
4. PR에 변경 목적, 검증 결과, 다른 저장소 의존성과 배포 순서를 적는다.
5. 리뷰와 CI 후 `main`에 병합한다.
6. 운영 담당자에게 저장소 이름과 병합 commit SHA를 전달한다.

서버에서 직접 수정한 뒤 나중에 GitHub로 옮기는 방식은 사용하지 않는다. 이 방식은
다음 배포가 서버 수정을 덮어쓰게 만들고, 실제 배포 소스를 제3자가 재현할 수 없게 한다.

## 운영 담당자의 배포

운영 담당자는 Mac Studio의 `backwardlabs` 배포 사용자로만 실행한다. 개인 GitHub
토큰 대신 저장소 read 권한만 가진 배포 자격증명을 사용한다.

```bash
ssh <운영 계정>@backwardlabss-mac-studio.tail344fa1.ts.net
sudo -iu backwardlabs
cd /Users/Shared/Projects/01_Daejang/daejang

# 변경 없이 현재 배포 commit과 오염 여부 확인
npm run mac-studio:status

# GitHub 접근, origin, main, clean checkout, fast-forward 가능 여부 확인
npm run mac-studio:preflight

# 모든 저장소를 origin/main으로 fast-forward하고 exact SHA 기록
npm run mac-studio:sync

# 전체 서비스 배포
npm run mac-studio:deploy
```

전체 배포는 모든 checkout 검증과 fast-forward가 끝난 뒤 `daejang/package-lock.json`에
맞춰 `npm ci`를 실행한다. 의존성 설치나 인덱서 사전 빌드가 실패하면 실행 중인 서비스를
중지하기 전에 종료한다.

EVM 인덱서만 긴급 복구할 때는 다음 명령을 사용한다.

```bash
npm run mac-studio:deploy-indexer
```

스크립트는 다음 경우 배포를 거부한다.

- 실행 사용자가 `backwardlabs`가 아님
- checkout이 `main`이 아님
- tracked 또는 일반 untracked 파일이 있음
- origin이 예상한 BackwardLabs 저장소가 아님
- GitHub 인증이 없거나 `origin/main`을 가져올 수 없음
- 로컬 main이 원격 main과 갈라져 fast-forward할 수 없음

소스 checkout 동기화와 실제 실행 배포는 서로 다른 파일에 기록된다.

```text
~/Library/Application Support/GIWA/production/source-checkouts.tsv
~/Library/Application Support/GIWA/production/deployed-release.tsv
~/Library/Application Support/GIWA/production/evm-indexer-deployed.tsv
```

`source-checkouts.tsv`는 서버에서 동기화한 소스 조합이고, 나머지 두 파일은 재시작까지
성공한 실행 버전이다. 소스가 최신이라는 사실만으로 실행 중인 서비스도 최신이라고
판단하지 않는다. 이 파일들에는 secret이 없다.

## 최초 한 번만 관리자가 준비할 것

- `backwardlabs` 사용자의 GitHub read-only 배포 인증
- `/Users/Shared/Projects/00_Backlight`와 `01_Daejang` 소유권·그룹 권한
- 운영 env, mTLS 인증서, JIT bridge, publication policy와 암호화키
- 팀 소유 Alchemy 앱의 Ethereum·Optimism RPC URL과 동일 자격증명의
  `GIWA_RPC_SHARED_CREDENTIAL_SHA256` 핀. 개인 RPC나 체인이 다른 endpoint는
  supervisor가 코어 서비스를 시작하기 전에 거부한다.
- 운영 runtime과 DB의 checkout 외부 백업
- 로그인 전에도 필요한 서비스는 LaunchAgent가 아니라 시스템 부팅 경계에서 실행
- 공동 임시 비밀번호 폐기와 사용자별 SSH 공개키 적용

일반 팀원에게 root 또는 secret 접근을 주는 것으로 배포 문제를 해결하지 않는다.
소스 변경은 PR 권한, 배포는 제한된 deploy 권한, secret은 운영 책임 권한으로 분리한다.

## 배포 후 확인

다음 결과를 배포 기록이나 작업 메시지에 남긴다.

- 저장소별 exact commit SHA
- EVM 인덱서가 같은 오류만 반복하지 않고 block/checkpoint가 전진하는지
- `npm run backend:status`의 모든 필수 서비스 상태
- 로컬 `/healthz`, `/readyz`
- 공개 `/api/v1/healthz`, `/api/v1/readyz`
- CEX 한 건과 EVM 한 건이 Source → JIT/Posting → Ledger로 재현되는지
- 실패하거나 비활성화한 기능과 담당자

정적 프런트가 HTTP 200인 것만으로 배포 성공으로 판단하지 않는다. API, worker,
인덱서 진행률과 사용자 거래 재현이 모두 확인되어야 한다.

## 현재 복구 시 주의사항

- migration 적용은 기존 업무 데이터 복구를 의미하지 않는다.
- Upbit quote archive 진행과 PostgreSQL 업무 데이터 복구는 별개다.
- DeFi profile runtime·validation 산출물은 Git에 포함된 release와 개인 로컬 자료를
  구분해 검증한 뒤 정본 release로 승격해야 한다.
- Etherscan 연동은 현재 서비스 복구의 선행 조건이 아니다. JIT/ingestion의 명시적
  evidence source로 설계·검증한 뒤 추가한다.
