SHELL := /bin/bash
GO := go
NPM := npm

# Version reported by `cnt-vnc-viewer -version` and shown in the web Settings
# panel. Override for a release build: VERSION=v1.2.3 make server
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -X github.com/condatainer/cnt-vnc-viewer/pkg/version.Version=$(VERSION)

# pkg/audio requires cgo (binds to libopus) with no non-cgo fallback -
# explicit here so the build doesn't depend on the environment's own default.
export CGO_ENABLED := 1

.PHONY: all frontend server test clean

all: frontend server

frontend:
	@echo "==> Building frontend assets (Vite + TypeScript)..."
	cd web && $(NPM) run build

server:
	@echo "==> Compiling cnt-vnc-viewer Go binary (version: $(VERSION))..."
	$(GO) build -v -ldflags "$(LDFLAGS)" -o cnt-vnc-viewer ./cmd/server

test:
	@echo "==> Running Go unit tests..."
	$(GO) test -v ./pkg/...

clean:
	@echo "==> Cleaning build artifacts..."
	rm -f cnt-vnc-viewer
	rm -rf cmd/server/dist/*


