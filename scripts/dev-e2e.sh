#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
db_dir=${DAEJANG_DB_DIR:-"$repo_root/../daejang-db"}
registry=${REGISTRY:-backwardlabss-mac-studio.tail344fa1.ts.net}
web_port=${DAEJANG_DEV_E2E_WEB_PORT:-15173}
e2e_subject_id=00000000-0000-4000-8000-00000000e2e1
compose_file="$repo_root/deploy/compose.dev-e2e.yaml"
state_dir="$repo_root/.runtime/dev-e2e"
state_file="$state_dir/state.env"

safe_segment() {
    printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

user_segment=$(safe_segment "$(id -un)")
user_segment=${user_segment#-}
user_segment=${user_segment%-}
[[ -n "$user_segment" ]] || user_segment=developer

web_test_image="daejang-web-api:dev-e2e-test-$user_segment"
web_candidate_image="daejang-web-api:dev-e2e-$user_segment"
web_ui_candidate_image="daejang-web-ui:dev-e2e-$user_segment"
engine_candidate_image="daejang-engine:dev-e2e-$user_segment"
parser_candidate_image="daejang-pdf-parser:dev-e2e-$user_segment"

require_command() {
    command -v "$1" >/dev/null 2>&1 || {
        printf '%s 명령을 찾을 수 없습니다.\n' "$1" >&2
        exit 2
    }
}

docker_host_dsn() {
    printf '%s' "$1" | sed 's/@127\.0\.0\.1:/@host.docker.internal:/'
}

state_value() {
    local name=$1 line value='' matches=0
    [[ -f "$state_file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "$name="* ]]; then
            value=${line#*=}
            matches=$((matches + 1))
        fi
    done < "$state_file"
    if (( matches != 1 )); then
        printf '상태 파일의 %s 값이 없거나 중복되었습니다: %s\n' "$name" "$state_file" >&2
        exit 2
    fi
    printf '%s' "$value"
}

require_state() {
    [[ -f "$state_file" ]] || {
        printf '%s\n' '유지 중인 dev E2E 환경이 없습니다. 먼저 make dev-e2e-up을 실행하세요.' >&2
        exit 2
    }
}

app_compose_from_state() {
    local app_env app_project
    app_env=$(state_value APP_ENV_FILE)
    app_project=$(state_value APP_PROJECT_NAME)
    "${compose_command[@]}" --env-file "$app_env" --project-directory "$repo_root" \
        --file "$compose_file" --project-name "$app_project" "$@"
}

db_compose_from_state() {
    local db_env db_project db_root
    db_env=$(state_value DB_ENV_FILE)
    db_project=$(state_value DB_PROJECT_NAME)
    db_root=$(state_value DB_REPO_ROOT)
    "${compose_command[@]}" --env-file "$db_env" --project-directory "$db_root" \
        --file "$db_root/compose.yaml" --project-name "$db_project" "$@"
}

action=${1:-test}
case "$action" in
    test|up|run-tests|down|status|logs) ;;
    --run-container-tests|--run-persistent) ;;
    *)
        printf 'usage: %s {test|up|run-tests|down|status|logs}\n' "$0" >&2
        exit 2
        ;;
esac

require_command docker
if docker compose version >/dev/null 2>&1; then
    compose_command=(docker compose)
elif [[ -x /Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose ]]; then
    compose_command=(/Applications/Docker.app/Contents/Resources/cli-plugins/docker-compose)
else
    printf '%s\n' 'Docker Compose를 찾을 수 없습니다.' >&2
    exit 2
fi

if [[ "$action" == down ]]; then
    require_state
    cleanup_status=0
    app_compose_from_state down --volumes --remove-orphans || cleanup_status=1
    db_compose_from_state down --volumes --remove-orphans || cleanup_status=1
    if (( cleanup_status == 0 )); then
        app_env=$(state_value APP_ENV_FILE)
        db_env=$(state_value DB_ENV_FILE)
        db_run_dir=$(dirname -- "$db_env")
        rm -f "$app_env" "$state_file" "$db_env"
        rmdir "$state_dir" "$db_run_dir" 2>/dev/null || true
        printf '%s\n' 'dev E2E의 컨테이너, network, 일회용 DB volume을 제거했습니다.'
    else
        printf '일부 환경을 정리하지 못했습니다. 상태 파일을 유지합니다: %s\n' "$state_file" >&2
        exit 1
    fi
    exit 0
fi

if [[ "$action" == status ]]; then
    require_state
    printf '%s\n' '[application]'
    app_compose_from_state ps
    printf '%s\n' '[database]'
    db_compose_from_state ps
    printf 'Web UI: http://localhost:%s\n' "$(state_value WEB_PORT)"
    exit 0
fi

if [[ "$action" == logs ]]; then
    require_state
    app_compose_from_state logs --follow --tail=200 web-ui web-api engine pdf-parser
    exit 0
fi

if [[ "$action" == run-tests ]]; then
    require_state
    app_compose_from_state run --rm --no-deps web-api-tests
    printf '%s\n' 'dev E2E 테스트가 통과했습니다. 실행 환경과 일회용 DB는 그대로 유지합니다.'
    exit 0
fi

if [[ "$action" == --run-container-tests || "$action" == --run-persistent ]]; then
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

    if [[ "$action" == --run-container-tests ]]; then
        runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/daejang-dev-e2e.XXXXXX")
        env_file="$runtime_dir/compose.env"
        project_name="daejang-$user_segment-dev-e2e-$$"
    else
        for required_variable in \
            DAEJANG_DB_DISPOSABLE_PROJECT DAEJANG_DB_ENV_FILE DAEJANG_DB_REPO_ROOT
        do
            [[ -n "${!required_variable:-}" ]] || {
                printf '%s is required.\n' "$required_variable" >&2
                exit 2
            }
        done
        [[ ! -e "$state_file" ]] || {
            printf '이미 유지 중인 dev E2E 환경이 있습니다: %s\n' "$state_file" >&2
            exit 2
        }
        mkdir -p -m 700 "$state_dir"
        chmod 700 "$state_dir"
        runtime_dir=$state_dir
        env_file="$state_dir/compose.env"
        project_name="daejang-$user_segment-dev-ui-$$"
    fi

    umask 077
    {
        printf 'DAEJANG_WEB_API_TEST_IMAGE=%s\n' "$web_test_image"
        printf 'DAEJANG_WEB_API_CANDIDATE_IMAGE=%s\n' "$web_candidate_image"
        printf 'DAEJANG_WEB_UI_CANDIDATE_IMAGE=%s\n' "$web_ui_candidate_image"
        printf 'DAEJANG_ENGINE_CANDIDATE_IMAGE=%s\n' "$engine_candidate_image"
        printf 'DAEJANG_PDF_PARSER_CANDIDATE_IMAGE=%s\n' "$parser_candidate_image"
        printf 'DAEJANG_DEV_E2E_WEB_PORT=%s\n' "$web_port"
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
        "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
            --file "$compose_file" --project-name "$project_name" \
            down --volumes --remove-orphans >/dev/null 2>&1 || true
        rm -f "$env_file"
        if [[ "$action" == --run-persistent ]]; then
            rm -f "$state_file"
        fi
        rmdir "$runtime_dir" 2>/dev/null || true
        exit "$exit_status"
    }
    trap cleanup_compose EXIT

    if [[ "$action" == --run-container-tests ]]; then
        "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
            --file "$compose_file" --project-name "$project_name" \
            up --abort-on-container-exit --exit-code-from web-api-tests web-api-tests
        exit 0
    fi

    "${compose_command[@]}" --env-file "$env_file" --project-directory "$repo_root" \
        --file "$compose_file" --project-name "$project_name" \
        up --detach --wait web-ui

    {
        printf 'APP_PROJECT_NAME=%s\n' "$project_name"
        printf 'APP_ENV_FILE=%s\n' "$env_file"
        printf 'DB_PROJECT_NAME=%s\n' "$DAEJANG_DB_DISPOSABLE_PROJECT"
        printf 'DB_ENV_FILE=%s\n' "$DAEJANG_DB_ENV_FILE"
        printf 'DB_REPO_ROOT=%s\n' "$DAEJANG_DB_REPO_ROOT"
        printf 'WEB_PORT=%s\n' "$web_port"
    } > "$state_file"
    trap - EXIT

    printf '\nWeb UI를 계속 실행합니다: http://localhost:%s\n' "$web_port"
    printf '%s\n' '테스트 계정: test@example.test / test1234!'
    printf '%s\n' '종료할 때만 make dev-e2e-down을 실행하세요.'
    exit 0
fi

require_command gh
[[ -x "$db_dir/scripts/with-disposable-postgres.sh" ]] || {
    printf '일회용 DB 실행기를 찾을 수 없습니다: %s\n' "$db_dir/scripts/with-disposable-postgres.sh" >&2
    exit 2
}
if [[ "$action" == up && -e "$state_file" ]]; then
    printf '%s\n' '이미 유지 중인 dev E2E 환경이 있습니다. make dev-e2e-status로 확인하거나 make dev-e2e-down으로 제거하세요.' >&2
    exit 2
fi
if [[ ! "$web_port" =~ ^[0-9]+$ ]] || (( web_port < 1 || web_port > 65535 )); then
    printf 'DAEJANG_DEV_E2E_WEB_PORT가 올바른 포트가 아닙니다: %s\n' "$web_port" >&2
    exit 2
fi

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

printf '%s\n' '현재 daejang checkout으로 후보 이미지를 만듭니다.'
if [[ "$action" == test || "$action" == up ]]; then
    "${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
        --file "$repo_root/apps/web-api/Dockerfile" --target test \
        --tag "$web_test_image" "$repo_root"
fi
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/apps/web-api/Dockerfile" --target runtime \
    --tag "$web_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target engine-runtime \
    --tag "$engine_candidate_image" "$repo_root"
"${buildx[@]}" build --load --secret "id=github_token,src=$token_file" \
    --file "$repo_root/services/engine/Dockerfile" --target parser-runtime \
    --tag "$parser_candidate_image" "$repo_root"
if [[ "$action" == up ]]; then
    "${buildx[@]}" build --load \
        --file "$repo_root/apps/web/Dockerfile" --target preview \
        --tag "$web_ui_candidate_image" "$repo_root"
fi

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
db_args=(
    --seed-web-test-account
    --role-env DAEJANG_E2E_OWNER_DATABASE_URL=owner
    --role-env DAEJANG_E2E_WEB_DATABASE_URL=web
    --role-env DAEJANG_E2E_SOURCE_DATABASE_URL=source
    --role-env DAEJANG_E2E_QUERY_DATABASE_URL=query
    --role-env DAEJANG_E2E_REPORT_DATABASE_URL=event
)
if [[ "$action" == up ]]; then
    db_args=(--keep "${db_args[@]}")
fi

DAEJANG_LOCAL_TEST_NAME=daejang-dev-e2e \
"$db_dir/scripts/with-disposable-postgres.sh" \
    "${db_args[@]}" \
    -- "$repo_root/scripts/dev-e2e.sh" \
    "$([[ "$action" == up ]] && printf '%s' --run-persistent || printf '%s' --run-container-tests)"

if [[ "$action" == test ]]; then
    printf '%s\n' 'daejang dev E2E가 통과했습니다.'
fi
