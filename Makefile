DAEJANG_DB_DIR ?= ../daejang-db
DAEJANG_JIT_ENGINE_DIR ?= ../daejang-jit-engine
DAEJANG_POSTING_SERVICE_DIR ?= ../daejang-posting-service
DAEJANG_TAX_ENGINE_DIR ?= ../daejang-tax-engine
SCHEMA_DIR ?= ../schema
REGISTRY ?= backwardlabss-mac-studio.tail344fa1.ts.net

.PHONY: test test-system
test:
	@DAEJANG_DB_DIR="$(DAEJANG_DB_DIR)" REGISTRY="$(REGISTRY)" ./scripts/dev-e2e.sh

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
