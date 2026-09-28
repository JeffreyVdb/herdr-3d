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

.PHONY: build go-build game-build test go-test game-test integration lint go-lint game-lint \
	helper-darwin dev shot deps clean

## build: Go binaries (bin/) + game bundle (game/dist/)
build: go-build game-build

go-build:
	$(GOBUILD) -o bin/ ./cmd/...

game-build: deps
	$(PNPM) build

## test: go test + vitest
test: go-test game-test

go-test:
	go test ./...

game-test: deps
	$(PNPM) test

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

## helper-darwin: cross-compile h3d-helper for macOS arm64 (CGO off)
helper-darwin:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 $(GOBUILD) -o bin/darwin-arm64/h3d-helper ./cmd/h3d-helper

## dev: Vite dev server on a leased port, 127.0.0.1 only
dev: deps
	$(PORTLEASE) --name dev --service game-dev -- \
		sh -c 'exec $(PNPM) exec vite --host 127.0.0.1 --port "$$PORTLEASE_DEV_PORT" --strictPort'

## shot: headless WebGL2 screenshot of the built game -> game/test-results/shot.png
shot: game-build
	rm -f game/test-results/shot.png
	$(PORTLEASE) --name preview --service game-shot -- $(PNPM) exec playwright test

## deps: install game dependencies from the lockfile
deps: game/node_modules/.modules.yaml

game/node_modules/.modules.yaml: game/package.json game/pnpm-lock.yaml
	$(PNPM) install --frozen-lockfile
	@touch $@

clean:
	rm -rf bin game/dist game/test-results
