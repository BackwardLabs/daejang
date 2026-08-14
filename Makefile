DAEJANG_DB_DIR ?= ../daejang-db
REGISTRY ?= backwardlabss-mac-studio.tail344fa1.ts.net

.PHONY: test
test:
	@DAEJANG_DB_DIR="$(DAEJANG_DB_DIR)" REGISTRY="$(REGISTRY)" ./scripts/dev-e2e.sh
