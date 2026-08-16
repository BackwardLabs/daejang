SHELL := /bin/sh

COMPOSE ?= docker-compose
ENV_FILE ?= .env
COMPOSE_ARGS := --env-file $(ENV_FILE) -f compose.yaml

.PHONY: init user client-login client-logout config pull up expose unexpose endpoint restart down status logs verify-local verify-tailnet images-publish images-pull images-list images-cleanup images-cleanup-dry-run publisher-run publisher-install publisher-status publisher-logs publisher-uninstall

init:
	@test -f $(ENV_FILE) || cp .env.example $(ENV_FILE)
	@./scripts/init-runtime.sh $(ENV_FILE)

user:
	@test -n "$(USER)" || { echo "Usage: make user USER=<name>" >&2; exit 2; }
	@./scripts/manage-user.sh $(ENV_FILE) "$(USER)"

client-login:
	@./scripts/docker-client-login.sh $(ENV_FILE)

client-logout:
	@./scripts/docker-client-logout.sh $(ENV_FILE)

images-publish:
	@./scripts/build-core-images.sh $(ENV_FILE)

images-pull:
	@./scripts/pull-core-images.sh

images-list:
	@./scripts/list-core-images.sh

images-cleanup:
	@./scripts/cleanup-images.sh

images-cleanup-dry-run:
	@./scripts/cleanup-images.sh --dry-run

publisher-run:
	@./scripts/publish-main-images.sh

publisher-install:
	@./scripts/install-publisher-agent.sh

publisher-status:
	@./scripts/publisher-status.sh

publisher-logs:
	@tail -n 200 -f /Users/Shared/DaejangRegistry/logs/publisher.stdout.log /Users/Shared/DaejangRegistry/logs/publisher.stderr.log /Users/Shared/DaejangRegistry/logs/cleaner.stdout.log /Users/Shared/DaejangRegistry/logs/cleaner.stderr.log

publisher-uninstall:
	@./scripts/uninstall-publisher-agent.sh

config:
	@$(COMPOSE) $(COMPOSE_ARGS) config --quiet

pull: config
	@$(COMPOSE) $(COMPOSE_ARGS) pull

up: config
	@./scripts/require-auth.sh $(ENV_FILE)
	@$(COMPOSE) $(COMPOSE_ARGS) up -d
	@./scripts/expose-tailnet.sh $(ENV_FILE)

expose:
	@./scripts/expose-tailnet.sh $(ENV_FILE)

unexpose:
	@./scripts/unexpose-tailnet.sh $(ENV_FILE)

endpoint:
	@./scripts/registry-endpoint.sh $(ENV_FILE)

restart: config
	@./scripts/require-auth.sh $(ENV_FILE)
	@$(COMPOSE) $(COMPOSE_ARGS) restart

down:
	@./scripts/unexpose-tailnet.sh $(ENV_FILE)
	@$(COMPOSE) $(COMPOSE_ARGS) down

status:
	@$(COMPOSE) $(COMPOSE_ARGS) ps
	@./scripts/tailscale-status.sh $(ENV_FILE)

logs:
	@$(COMPOSE) $(COMPOSE_ARGS) logs -f --tail=200

verify-local:
	@./scripts/verify.sh $(ENV_FILE) local

verify-tailnet:
	@./scripts/verify.sh $(ENV_FILE) tailnet
