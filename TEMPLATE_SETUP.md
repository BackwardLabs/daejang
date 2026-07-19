# 템플릿 저장소 설정

이 문서는 템플릿 원본을 만들 때 한 번, 템플릿에서 새 저장소를 생성할 때 한 번 확인합니다.

## 템플릿 원본 설정

1. 이 디렉터리의 파일을 새 GitHub 저장소에 올립니다.
2. 저장소의 **Settings → General**에서 **Template repository**를 활성화합니다.
3. 기본 브랜치에 이슈 및 PR 템플릿이 모두 포함되어 있는지 확인합니다.

## 새 저장소 생성 후

- [ ] `README.md`의 프로젝트 이름, 설명, 실행 방법을 실제 내용으로 바꿨습니다.
- [ ] `AGENTS.md`의 프로젝트 정보와 명령어를 실제 내용으로 바꾸고 명령이 동작하는지 확인했습니다.
- [ ] Claude Code를 사용한다면 `/setup`을 실행하고 `CLAUDE.md`와 `.claude/settings.json`을 검토했습니다. 저장소 고유의 비밀 경로를 차단 규칙에 추가하고, 초기화 후 일회성 setup 스킬을 유지할지도 결정했습니다.
- [ ] `.github/CODEOWNERS.example`을 검토했습니다. 실제 소유자가 정해졌다면 `CODEOWNERS`로 복사하고, 아니면 예시 파일을 삭제했습니다.
- [ ] Issues 기능을 활성화하고 **New issue** 화면에서 버그, 기능 요청, 작업 템플릿을 확인했습니다.
- [ ] `bug`, `enhancement` 라벨이 존재하는지 확인했습니다. 템플릿 저장소의 라벨과 저장소 설정은 새 저장소에 그대로 복제되지 않을 수 있습니다.
- [ ] Linear의 GitHub integration에 새 저장소를 연결하고 팀별 브랜치 형식을 설정했습니다.
- [ ] GitHub Issues Sync를 **One-way: GitHub → Linear**로 연결했습니다. 여러 저장소는 동일한 Linear 팀에 각각 연결합니다.
- [ ] 기본 브랜치 ruleset 또는 branch protection을 설정하고 PR 리뷰 수, 코드 소유자 승인, 필요한 상태 검사를 정했습니다.
- [ ] 보안 제보 채널을 정했습니다. 공개 저장소라면 private vulnerability reporting 또는 별도 `SECURITY.md`를 설정합니다.
- [ ] 팀에 맞지 않는 이슈 필드와 PR 체크 항목을 정리했습니다.
- [ ] 설정이 끝난 뒤 이 파일을 삭제했습니다.

> GitHub 공식 문서는 Issue Forms의 `required` 검증을 public 저장소에 적용되는 기능으로 설명합니다. internal/private 저장소에서는 실제 동작을 확인하고, 필수 입력 여부를 권한이나 보안 통제로 사용하지 마세요.

## 멀티 레포 협업 기준

- 관련 저장소와 PR을 이슈 및 PR 본문에 모두 링크합니다.
- Linear 이슈의 **Copy git branch name**으로 브랜치를 만들고 이슈 ID를 유지합니다.
- 병합 순서가 있으면 의존성, 호환성 유지 기간, 배포 순서를 명시합니다.
- 여러 저장소를 동시에 깨뜨리는 변경보다 이전 버전과 호환되는 단계적 변경을 우선합니다.
- 저장소별 담당 팀이 다르면 각 저장소에 별도의 `CODEOWNERS`를 설정합니다.
