DAEJANG_DB_DIR ?= /Users/shared/Projects/01_Daejang/daejang-db
DAEJANG_JIT_ENGINE_DIR ?= ../daejang-jit-engine
DAEJANG_POSTING_SERVICE_DIR ?= ../daejang-posting-service
DAEJANG_TAX_ENGINE_DIR ?= ../daejang-tax-engine
DAEJANG_REVIEWROOM_DIR ?= ../daejang-reviewroom
SCHEMA_DIR ?= /Users/shared/Projects/01_Daejang/schema
REGISTRY ?= backwardlabss-mac-studio.tail344fa1.ts.net
DAEJANG_DEV_E2E_WEB_PORT ?= 15173
DAEJANG_DEV_E2E_REOWN_PROJECT_ID ?= c5f8295da4fda205b905f32fd523f4c9
DAEJANG_TAXD_DB_MIGRATION_VERSION ?= 90
DAEJANG_TAX_DEV_E2E_TAX_YEAR ?= 2025
DAEJANG_E2E_SUFFIX ?=

.PHONY: test test-review-giwa test-system dev-e2e-up dev-e2e-test dev-e2e-down dev-e2e-status dev-e2e-logs
test:
	@DAEJANG_DB_DIR="$(DAEJANG_DB_DIR)" REGISTRY="$(REGISTRY)" \
		DAEJANG_TAXD_DB_MIGRATION_VERSION="$(DAEJANG_TAXD_DB_MIGRATION_VERSION)" \
		DAEJANG_TAX_DEV_E2E_TAX_YEAR="$(DAEJANG_TAX_DEV_E2E_TAX_YEAR)" \
		./scripts/dev-e2e.sh test

test-review-giwa:
	@DAEJANG_DB_DIR="$(DAEJANG_DB_DIR)" REGISTRY="$(REGISTRY)" \
		DAEJANG_REVIEWROOM_DIR="$(DAEJANG_REVIEWROOM_DIR)" \
		DAEJANG_TAXD_DB_MIGRATION_VERSION="$(DAEJANG_TAXD_DB_MIGRATION_VERSION)" \
		DAEJANG_TAX_DEV_E2E_TAX_YEAR="$(DAEJANG_TAX_DEV_E2E_TAX_YEAR)" \
		DAEJANG_E2E_SUFFIX="$(DAEJANG_E2E_SUFFIX)" \
		./scripts/dev-e2e.sh test-review-giwa

dev-e2e-up:
	@DAEJANG_DB_DIR="$(DAEJANG_DB_DIR)" REGISTRY="$(REGISTRY)" \
		DAEJANG_DEV_E2E_WEB_PORT="$(DAEJANG_DEV_E2E_WEB_PORT)" \
		DAEJANG_DEV_E2E_REOWN_PROJECT_ID="$(DAEJANG_DEV_E2E_REOWN_PROJECT_ID)" \
		DAEJANG_TAXD_DB_MIGRATION_VERSION="$(DAEJANG_TAXD_DB_MIGRATION_VERSION)" \
		DAEJANG_TAX_DEV_E2E_TAX_YEAR="$(DAEJANG_TAX_DEV_E2E_TAX_YEAR)" \
		./scripts/dev-e2e.sh up

dev-e2e-test:
	@./scripts/dev-e2e.sh run-tests

dev-e2e-down:
	@./scripts/dev-e2e.sh down

dev-e2e-status:
	@./scripts/dev-e2e.sh status

dev-e2e-logs:
	@./scripts/dev-e2e.sh logs

test-system: test
	@$(MAKE) -C "$(DAEJANG_POSTING_SERVICE_DIR)" test \
		DAEJANG_DB_DIR="$(abspath $(DAEJANG_DB_DIR))" REGISTRY="$(REGISTRY)"
	@$(MAKE) -C "$(DAEJANG_JIT_ENGINE_DIR)" test \
		DAEJANG_DB_DIR="$(abspath $(DAEJANG_DB_DIR))" \
		SCHEMA_DIR="$(abspath $(SCHEMA_DIR))" REGISTRY="$(REGISTRY)" \
		POSTING_IMAGE=daejang-posting-service:dev-e2e-runtime
	@$(MAKE) -C "$(DAEJANG_TAX_ENGINE_DIR)" test \
		DAEJANG_DB_DIR="$(abspath $(DAEJANG_DB_DIR))" REGISTRY="$(REGISTRY)" \
		POSTING_IMAGE=daejang-posting-service:dev-e2e-runtime
