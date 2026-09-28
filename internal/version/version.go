// Package version holds the build version, injected at link time:
//
//	go build -ldflags "-X github.com/JeffreyVdb/herdr-3d/internal/version.Version=v1.2.3"
package version

// Version is overridden via -ldflags; "dev" marks an unstamped build.
var Version = "dev"
