BINARY=bin/opspilot-agent
.PHONY: build test tidy build-all
build:
	mkdir -p bin
	go build -trimpath -ldflags="-s -w" -o $(BINARY) ./cmd/opspilot-agent
test:
	go test ./...
tidy:
	go mod tidy
build-all:
	mkdir -p bin
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -o bin/opspilot-agent-linux-amd64 ./cmd/opspilot-agent
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o bin/opspilot-agent-linux-arm64 ./cmd/opspilot-agent
