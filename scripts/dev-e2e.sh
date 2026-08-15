#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
db_dir=${DAEJANG_DB_DIR:-"$repo_root/../daejang-db"}
registry=${REGISTRY:-backwardlabss-mac-studio.tail344fa1.ts.net}
web_test_image=daejang-web-api:dev-e2e-test
web_candidate_image=daejang-web-api:dev-e2e
engine_candidate_image=daejang-engine:dev-e2e
parser_candidate_image=daejang-pdf-parser:dev-e2e
e2e_subject_id=00000000-0000-4000-8000-00000000e2e1
compose_file="$repo_root/deploy/compose.dev-e2e.yaml"

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf '%s 명령을 찾을 수 없습니다.\n' "$1" >&2
        exit 2
    }
}

docker_host_dsn() {
    printf '%s' "$1" | sed 's/@127\.0\.0\.1:/@host.docker.internal:/'
}

if [[ "${1:-}" == "--run-container-tests" ]]; then
    for required_variable in \
        DAEJANG_E2E_OWNER_DATABASE_URL DAEJANG_E2E_WEB_DATABASE_URL \
        DAEJANG_E2E_SOURCE_DATABASE_URL DAEJANG_E2E_QUERY_DATABASE_URL \
        DAEJANG_E2E_REPORT_DATABASE_URL
    do
        [[ -n "${!required_variable:-}" ]] || {
            printf '%s is required.\n' "$required_variable" >&2
            exit 2
        }
    done

    runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/daejang-dev-e2e.XXXXXX")
    env_file="$runtime_dir/compose.env"
    project_name="daejang-dev-e2e-$$"
    umask 077
    {
        printf 'DAEJANG_WEB_API_TEST_IMAGE=%s\n' "$web_test_image"
        printf 'DAEJANG_ENGINE_CANDIDATE_IMAGE=%s\n' "$engine_candidate_image"
        printf 'DAEJANG_PDF_PARSER_CANDIDATE_IMAGE=%s\n' "$parser_candidate_image"
        printf 'DAEJANG_E2E_SUBJECT_ID=%s\n' "$e2e_subject_id"
        printf 'OWNER_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_OWNER_DATABASE_URL")"
        printf 'WEB_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_WEB_DATABASE_URL")"
        printf 'SOURCE_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_SOURCE_DATABASE_URL")"
        printf 'SOURCE_ARTIFACT_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_SOURCE_DATABASE_URL")"
        printf 'QUERY_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_QUERY_DATABASE_URL")"
        printf 'REPORT_DATABASE_URL=%s\n' "$(docker_host_dsn "$DAEJANG_E2E_REPORT_DATABASE_URL")"
    } > "$env_file"

    cleanup_compose() {
        exit_status=$?
        trap - EXIT
        docker compose --env-file "$env_file" --project-directory "$repo_root" \
            --file "$compose_file" --project-name "$project_name" \
            down --volumes --remove-orphans >/dev/null 2>&1 || true
        rm -rf "$runtime_dir"
        exit "$exit_status"
    }
    trap cleanup_compose EXIT

    docker compose --env-file "$env_file" --project-directory "$repo_root" \
        --file "$compose_file" --project-name "$project_name" \
        up --abort-on-container-exit --exit-code-from web-api-tests web-api-tests
    exit 0
fi

require_command docker
require_command gh
[[ -x "$db_dir/scripts/with-disposable-postgres.sh" ]] || {
    printf '일회용 DB 실행기를 찾을 수 없습니다: %s\n' "$db_dir/scripts/with-disposable-postgres.sh" >&2
    exit 2
}

runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/daejang-dev-e2e-build.XXXXXX")
token_file="$runtime_dir/github-token"
plugin_config="$runtime_dir/docker-config"
cleanup_build() {
    exit_status=$?
    trap - EXIT
    rm -rf "$runtime_dir"
    exit "$exit_status"
}
trap cleanup_build EXIT
umask 077
gh auth token > "$token_file"

printf '%s\n' 'Registry의 최신 기준 이미지 6개를 확인합니다.'
for image in web-api engine pdf-parser jit-engine posting-service tax-engine; do
    full_image="$registry/daejang/$image:latest"
    docker pull "$full_image"
    digest=$(docker image inspect --format '{{join .RepoDigests " "}}' "$full_image")
    printf '  %-16s %s\n' "$image" "$digest"
done

if docker buildx version >/dev/null 2>&1; then
    buildx=(docker buildx)
elif [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx ]]; then
    buildx=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-buildx)
else
    printf '%s\n' 'Docker Buildx를 찾을 수 없습니다.' >&2
    exit 2
fi

printf '%s\n' '현재 daejang 체크아웃으로 후보 이미지를 만듭니다.'
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/apps/web-api/Dockerfile" --target test \
    --tag "$web_test_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/apps/web-api/Dockerfile" --target runtime \
    --tag "$web_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target engine-runtime \
    --tag "$engine_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target parser-runtime \
    --tag "$parser_candidate_image" "$repo_root"

if ! docker compose version >/dev/null 2>&1; then
    compose_plugin=/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose
    [[ -x "$compose_plugin" ]] || {
        printf '%s\n' 'Docker Compose를 찾을 수 없습니다.' >&2
        exit 2
    }
    mkdir -p "$plugin_config/cli-plugins"
    ln -s "$compose_plugin" "$plugin_config/cli-plugins/docker-compose"
    export DOCKER_CONFIG="$plugin_config"
fi

printf '%s\n' '현재 후보 Web API, Engine, PDF parser를 일회용 DB에 연결합니다.'
DAEJANG_LOCAL_TEST_NAME=daejang-dev-e2e \
"$db_dir/scripts/with-disposable-postgres.sh" \
    --seed-web-test-account \
    --role-env DAEJANG_E2E_OWNER_DATABASE_URL=owner \
    --role-env DAEJANG_E2E_WEB_DATABASE_URL=web \
    --role-env DAEJANG_E2E_SOURCE_DATABASE_URL=source \
    --role-env DAEJANG_E2E_QUERY_DATABASE_URL=query \
    --role-env DAEJANG_E2E_REPORT_DATABASE_URL=event \
    -- "$repo_root/scripts/dev-e2e.sh" --run-container-tests

printf '%s\n' 'daejang dev E2E가 통과했습니다.'
