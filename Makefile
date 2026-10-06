SHELL := /bin/sh
.DEFAULT_GOAL := build

MODULE  := github.com/JeffreyVdb/herdr-3d
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X $(MODULE)/internal/version.Version=$(VERSION)
GOBUILD := go build -trimpath -ldflags "$(LDFLAGS)"

PNPM := pnpm -C game
# Never download Playwright browsers; use the cached Chromium in ~/.cache/ms-playwright.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD := 1

# Ports are leased from portlease, never hardcoded. Servers bind 127.0.0.1 only.
PORTLEASE := portlease run --project herdr-3d --worktree "$(CURDIR)"

# One Playwright run (make e2e / make shot) per host: two suites at once both drop below 10 fps on llvmpipe and flake.
# The subshell holds the lock on fd 9 and the run itself gets no copy (9>&-), so the lock goes when the subshell exits
# (success, failure, ctrl-c), even if a stray browser outlives it. Waiting is announced only when there is a wait.
# No flock, or a lock that can't be taken, fails the recipe before Playwright starts: never an unlocked run.
E2E_LOCK := $${XDG_RUNTIME_DIR:-/tmp}/herdr-3d-e2e.lock
E2E_LOCKED = command -v flock >/dev/null || { echo "make: flock not found (util-linux); needed for the e2e lock" >&2; exit 1; }; \
	flock -n 9 || { echo "waiting for another worktree's e2e run ($(E2E_LOCK))..." >&2; \
	flock 9 || { echo "make: could not take the e2e lock ($(E2E_LOCK))" >&2; exit 1; }; }

# The built game is copied here and embedded in h3d-helper (internal/webdist).
EMBED_DIR := internal/webdist/game
RELEASE_DIR := bin/release

.PHONY: build go-build game-build test go-test game-test integration codex-shared-tui lint go-lint game-lint \
	sh-test embed-game helper-darwin release-assets dev shot e2e setup toolchain deps clean

## build: Go binaries (bin/) + game bundle (game/dist/)
build: go-build game-build

go-build:
	$(GOBUILD) -o bin/ ./cmd/...

game-build: deps
	H3D_VERSION="$(VERSION)" $(PNPM) build

## test: go test + vitest + the deploy script test
test: go-test game-test sh-test

go-test:
	go test ./...

game-test: deps
	$(PNPM) test

## sh-test: shellcheck + fake-environment test of deploy/h3d-update
sh-test:
	shellcheck deploy/h3d-update deploy/test-h3d-update.sh
	bash deploy/test-h3d-update.sh

## integration: bridge against a real herdr, in a throwaway session it creates and deletes (h3d-it-*)
integration:
	go test -tags integration -count=1 -run Integration -v ./internal/app/ ./internal/limits/

## codex-shared-tui: #154 fixture: the real Codex TUI (codex-cli 0.160.1) beside a second app-server client, in
## throwaway herdr sessions (h3d-it-154-*), temp CODEX_HOMEs and mock inference; EVIDENCE=<dir> keeps screens/messages
codex-shared-tui:
	H3D_CODEXSHARE_EVIDENCE="$(EVIDENCE)" go test -tags integration -count=1 -timeout 30m -run CodexShare -v ./internal/codexshare/

## lint: go vet, gofmt, tsc --noEmit
lint: go-lint game-lint

go-lint:
	go vet ./...
	go vet -tags integration ./...
	@unformatted="$$(go list -f '{{.Dir}}' ./... | xargs gofmt -l)"; \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi

game-lint: deps
	$(PNPM) typecheck

## embed-game: build the game and copy game/dist into the helper's embed dir (internal/webdist/game)
embed-game: game-build
	find $(EMBED_DIR) -mindepth 1 ! -name .gitkeep -delete
	cp -R game/dist/. $(EMBED_DIR)/

## helper-darwin: cross-compile h3d-helper for macOS arm64 (CGO off); embeds whatever `make embed-game` last copied
helper-darwin:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GOBUILD) -o bin/darwin-arm64/h3d-helper ./cmd/h3d-helper

## release-assets: the files a GitHub release carries -> bin/release/ (bridge for Linux, helper with the game embedded for macOS, SHA256SUMS)
release-assets: embed-game
	rm -rf $(RELEASE_DIR) && mkdir -p $(RELEASE_DIR)
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 $(GOBUILD) -o $(RELEASE_DIR)/herdr-world-linux-amd64 ./cmd/herdr-world
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GOBUILD) -o $(RELEASE_DIR)/h3d-helper-darwin-arm64 ./cmd/h3d-helper
	cd $(RELEASE_DIR) && sha256sum herdr-world-linux-amd64 h3d-helper-darwin-arm64 > SHA256SUMS

## dev: Vite dev server on a leased port, 127.0.0.1 only
dev: deps
	$(PORTLEASE) --name dev --service game-dev -- \
		sh -c 'exec $(PNPM) exec vite --host 127.0.0.1 --port "$$PORTLEASE_DEV_PORT" --strictPort'

## shot: headless WebGL2 screenshot of the built game -> game/test-results/shot.png (e2e/shot.spec.ts only)
shot: game-build
	rm -f game/test-results/shot.png
	@( $(E2E_LOCKED); set -x; $(PORTLEASE) --name preview --service game-shot -- $(PNPM) exec playwright test e2e/shot.spec.ts 9>&- ) 9>"$(E2E_LOCK)"

## e2e: the full headless Playwright suite (all e2e/*.spec.ts, H3D_WORKERS parallel workers; one run per host); SPEC=e2e/x.spec.ts runs only that file
e2e: game-build
	@( $(E2E_LOCKED); set -x; $(PORTLEASE) --name preview --service game-e2e -- $(PNPM) exec playwright test $(SPEC) 9>&- ) 9>"$(E2E_LOCK)"

## setup: make a fresh worktree test-ready: toolchain check, game deps, Go module cache (idempotent, ~3 s warm)
setup:
	@$(MAKE) --no-print-directory toolchain
	@$(MAKE) --no-print-directory deps
	go mod download
	@echo "setup ok: next 'make lint' then 'make shot' (docs/git-worktrees.md)"

# Pins are read from go.mod (minimum Go), game/.nvmrc and game/package.json (packageManager), the same files CI reads.
GO_WANT   = $(shell sed -n 's/^go \([0-9]*\.[0-9]*\).*/\1/p' go.mod)
NODE_WANT = $(shell sed 's/^v//' game/.nvmrc | cut -d. -f1,2)
PNPM_WANT = $(shell sed -n 's/.*"packageManager": *"pnpm@\([0-9]*\.[0-9]*\).*/\1/p' game/package.json)

## toolchain: fail with a clear message when go, node, pnpm, portlease or flock is missing or the wrong version
toolchain:
	@fail=0; \
	miss() { echo "make setup: $$1 not found on PATH ($$2)" >&2; fail=1; }; \
	wrong() { echo "make setup: $$1 $$2 found, need $$3 ($$4)" >&2; fail=1; }; \
	if command -v go >/dev/null; then \
		v=$$(go env GOVERSION | sed 's/^go//'); \
		[ "$$(printf '%s\n%s\n' "$(GO_WANT)" "$$v" | sort -V | head -n1)" = "$(GO_WANT)" ] || wrong go "$$v" ">= $(GO_WANT)" "go.mod"; \
	else miss go "need >= $(GO_WANT), see go.mod"; fi; \
	if command -v node >/dev/null; then \
		v=$$(node -v | sed 's/^v//' | cut -d. -f1,2); \
		[ "$$v" = "$(NODE_WANT)" ] || wrong node "$$v" "$(NODE_WANT)" "game/.nvmrc"; \
	else miss node "need $(NODE_WANT), see game/.nvmrc"; fi; \
	if command -v pnpm >/dev/null; then \
		v=$$(pnpm -v | cut -d. -f1,2); \
		[ "$$v" = "$(PNPM_WANT)" ] || wrong pnpm "$$v" "$(PNPM_WANT)" "packageManager in game/package.json"; \
	else miss pnpm "need $(PNPM_WANT), see packageManager in game/package.json"; fi; \
	command -v portlease >/dev/null || miss portlease "ports are leased from it, never hardcoded"; \
	command -v flock >/dev/null || miss flock "util-linux; needed for the e2e lock"; \
	exit $$fail

## deps: install game dependencies from the lockfile
deps: game/node_modules/.modules.yaml

game/node_modules/.modules.yaml: game/package.json game/pnpm-lock.yaml
	$(PNPM) install --frozen-lockfile
	@touch $@

clean:
	rm -rf bin game/dist game/test-results
	find $(EMBED_DIR) -mindepth 1 ! -name .gitkeep -delete
