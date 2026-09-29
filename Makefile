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

# The built game is copied here and embedded in h3d-helper (internal/webdist).
EMBED_DIR := internal/webdist/game
RELEASE_DIR := bin/release

.PHONY: build go-build game-build test go-test game-test integration lint go-lint game-lint \
	sh-test embed-game helper-darwin release-assets dev shot e2e deps clean

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
	go test -tags integration -count=1 -run Integration -v ./internal/app/

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
	$(PORTLEASE) --name preview --service game-shot -- $(PNPM) exec playwright test e2e/shot.spec.ts

## e2e: the full headless Playwright suite (all e2e/*.spec.ts, H3D_WORKERS parallel workers)
e2e: game-build
	$(PORTLEASE) --name preview --service game-e2e -- $(PNPM) exec playwright test

## deps: install game dependencies from the lockfile
deps: game/node_modules/.modules.yaml

game/node_modules/.modules.yaml: game/package.json game/pnpm-lock.yaml
	$(PNPM) install --frozen-lockfile
	@touch $@

clean:
	rm -rf bin game/dist game/test-results
	find $(EMBED_DIR) -mindepth 1 ! -name .gitkeep -delete
